import { Resolver } from "node:dns/promises";
import { request } from "node:https";
import type { IncomingMessage } from "node:http";
import ipaddr from "ipaddr.js";
import { load } from "cheerio";
import { ResearchError, type ReadPage } from "../core/research.js";

const bodyLimit = 512 * 1024;
const maxRedirects = 3;
const redirectCodes = new Set([301, 302, 303, 307, 308]);
const ipv4Special = ["192.88.99.0/24", "192.0.0.0/24"].map((prefix) => ipaddr.IPv4.parseCIDR(prefix));
const ipv6Global = ipaddr.IPv6.parseCIDR("2000::/3");
const ipv6Special = ["2001::/23", "2002::/16", "3fff::/20"].map((prefix) => ipaddr.IPv6.parseCIDR(prefix));

export function isPublicAddress(value: string): boolean {
  if (ipaddr.IPv4.isValidFourPartDecimal(value)) {
    const address = ipaddr.IPv4.parse(value);
    return address.range() === "unicast" && !ipv4Special.some((prefix) => address.match(prefix));
  }
  if (!ipaddr.IPv6.isValid(value) || value.includes("%")) return false;
  const address = ipaddr.IPv6.parse(value);
  return address.range() === "unicast" && address.match(ipv6Global)
    && !ipv6Special.some((prefix) => address.match(prefix));
}

export function publicHttpsUrl(input: string, base?: URL): URL {
  const url = URL.parse(input, base);
  if (!url || url.href.length > 2048 || url.protocol !== "https:" || url.port
      || url.username || url.password || !url.hostname.includes(".")
      || !/^[a-z0-9.-]+$/u.test(url.hostname) || ipaddr.isValid(url.hostname)
      || /(?:^|\.)(?:local|localhost|internal|home\.arpa)\.?$/u.test(url.hostname)) {
    throw new ResearchError("INVALID_REQUEST", "Expected a public HTTPS hostname on port 443.");
  }
  url.hash = "";
  return url;
}

async function resolvePublic(hostname: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const resolver = new Resolver();
  const cancel = () => resolver.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const records = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
    signal.throwIfAborted();
    const addresses = records.flatMap((record) => record.status === "fulfilled" ? record.value : []);
    if (!addresses.length) throw new ResearchError("READ_FAILED", "The hostname did not resolve.");
    if (addresses.some((address) => !isPublicAddress(address))) {
      throw new ResearchError("INVALID_REQUEST", "The hostname resolved to a blocked network.");
    }
    return addresses[0];
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

function open(url: URL, address: string, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    // Connect to the validated IP without a second lookup. TLS still verifies the URL hostname.
    const req = request({
      hostname: address,
      servername: url.hostname.replace(/\.$/u, ""),
      port: 443,
      path: url.pathname + url.search,
      method: "GET",
      signal,
      agent: false,
      rejectUnauthorized: true,
      maxHeaderSize: 16 * 1024,
      headers: {
        host: url.hostname,
        accept: "text/html, text/plain, application/xhtml+xml",
        "accept-encoding": "identity",
        "user-agent": "SourceQuest/0.1",
      },
    }, resolve);
    req.once("error", reject);
    req.end();
  });
}

async function readBody(response: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response) {
    bytes += chunk.length;
    if (bytes > bodyLimit) throw new ResearchError("BUDGET_EXHAUSTED", "The page exceeded 512 KiB.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

function extract(body: string, mime: string): { title: string; text: string } {
  if (mime === "text/plain") return { title: "", text: body };
  const $ = load(body);
  const title = $("title").first().text().trim().slice(0, 200);
  $("script,style,template,noscript,nav,footer,aside,[hidden],[aria-hidden='true']").remove();
  const main = $("main, article, [role='main']").first();
  const root = main.length ? main : $("body");
  root.find("br").replaceWith("\n");
  root.find("p,h1,h2,h3,h4,li,div,pre,tr,blockquote").prepend("\n");
  return { title, text: root.text() };
}

export async function readPublicHttps(input: string, signal: AbortSignal): Promise<ReadPage> {
  let url = publicHttpsUrl(input);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const address = await resolvePublic(url.hostname, signal);
    const response = await open(url, address, signal);
    try {
      const status = response.statusCode ?? 0;
      if (redirectCodes.has(status)) {
        const location = response.headers.location;
        if (!location || hop === maxRedirects) {
          throw new ResearchError("READ_FAILED", "The redirect limit was reached or the target was missing.");
        }
        url = publicHttpsUrl(location, url);
        continue;
      }
      if (status === 429) throw new ResearchError("RATE_LIMITED", "The site rate-limited the request.");
      if (status === 401 || status === 403) {
        throw new ResearchError("AUTH_REQUIRED", "The site denied public access.");
      }
      if (status !== 200) throw new ResearchError("READ_FAILED", `The site returned HTTP ${status}.`);

      const type = response.headers["content-type"] ?? "";
      const mime = type.split(";", 1)[0].trim().toLowerCase();
      const encoding = response.headers["content-encoding"]?.toLowerCase();
      if (!["text/plain", "text/html", "application/xhtml+xml"].includes(mime)
          || (encoding && encoding !== "identity")) {
        throw new ResearchError("UNSUPPORTED_MIME", "Expected an uncompressed HTML or plain text page.");
      }
      const charset = type.match(/;\s*charset\s*=\s*"?([^";\s]+)/iu)?.[1] ?? "utf-8";
      let decoder: TextDecoder;
      try {
        decoder = new TextDecoder(charset);
      } catch {
        throw new ResearchError("UNSUPPORTED_MIME", "The response uses an unsupported character encoding.");
      }
      const body = await readBody(response);
      signal.throwIfAborted();
      return { finalUrl: url.href, mime, ...extract(decoder.decode(body), mime) };
    } finally {
      response.destroy();
    }
  }
  throw new ResearchError("READ_FAILED", "The redirect limit was reached.");
}

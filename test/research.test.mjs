import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { isPublicAddress, publicHttpsUrl } from "../dist/adapters/public-https.js";
import { research, researchRequestSchema, ResearchError, routedSearchError } from "../dist/core/research.js";

const normalizeUrl = (url) => publicHttpsUrl(url).href;

test("research isolates search failures, preserves query parameters and locates exact excerpts", async () => {
  const reads = [];
  const document = "Article heading\nVisible source material.\n这里记录了测试结果。\nNotes";
  const result = await research({
    queries: ["unavailable", "测试结果"],
    urls: ["https://example.com/report?v=2#heading"],
  }, {
    normalizeUrl,
    async search(query) {
      if (query === "unavailable") throw new Error("secret upstream debug payload");
      return [
        { url: "https://example.com/report?v=2#another-heading", title: "Report" },
        { url: "https://example.com/report?v=1", title: "Old report" },
        { url: "https://127.0.0.1/admin" },
      ];
    },
    async read(url) {
      reads.push(url);
      return { finalUrl: url, mime: "text/html", title: "Fixture", text: document };
    },
  }, new AbortController().signal);

  assert.equal(result.status, "partial");
  assert.deepEqual(reads, ["https://example.com/report?v=2", "https://example.com/report?v=1"]);
  assert.equal(result.sources.length, 2);
  assert.equal(result.evidence.length, 2);
  const [evidence] = result.evidence;
  assert.match(evidence.quote, /^这里记录了测试结果。/u);
  assert.equal(document.slice(evidence.start, evidence.end), evidence.quote);
  assert.equal(evidence.snapshotHash, createHash("sha256").update(document).digest("hex"));
  assert.equal(result.issues[0].code, "SEARCH_FAILED");
  assert.equal(JSON.stringify(result).includes("secret upstream"), false);
});

test("caller cancellation reaches the in-flight search and prevents reads", async () => {
  const controller = new AbortController();
  const failure = new Error("Cancelled by caller");
  const operation = research({ queries: ["query"] }, {
    normalizeUrl,
    search(_query, _limit, signal) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
    read() { assert.fail("No read should start"); },
  }, controller.signal);
  controller.abort(failure);
  await assert.rejects(operation, { message: failure.message });
});

test("read policy rejects IP literals and special-purpose DNS results", () => {
  for (const ip of ["0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254",
    "172.16.1.1", "192.168.1.1", "192.88.99.1", "192.0.2.1", "198.18.0.1", "224.0.0.1",
    "::1", "::ffff:127.0.0.1", "64:ff9b::7f00:1", "fc00::1", "fe80::1", "2002:7f00:1::",
    "2001:db8::1", "3fff::1"]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  assert.equal(isPublicAddress("1.1.1.1"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  for (const url of ["https://[::1]/", "https://2130706433/", "https://0177.0.0.1/",
    "https://metadata.google.internal/", "https://a.home.arpa/", "https://example.com:444/",
    "https://user@example.com/", "http://example.com/"]) {
    assert.throws(() => normalizeUrl(url), /public HTTPS/u, url);
  }
});


test("retains the inline citation when the snapshot cannot be committed", async () => {
  const document = "Evidence survives a storage failure.";
  const result = await research({ urls: ["https://example.com/"] }, {
    normalizeUrl,
    search() { assert.fail("No search should start"); },
    async read(url) {
      return { finalUrl: url, mime: "text/plain", title: "Fixture", text: document };
    },
    saveSnapshot() { throw new Error("filesystem details"); },
  }, new AbortController().signal);
  assert.equal(result.status, "partial");
  assert.equal(result.evidence[0].quote, document);
  assert.equal(result.evidence[0].snapshotSaved, false);
  assert.equal(result.issues[0].code, "STORAGE_FAILED");
  assert.equal(JSON.stringify(result).includes("filesystem details"), false);
});

test("forwards search source and allowFallback without mutating legacy request shapes", async () => {
  const legacy = researchRequestSchema.parse({ queries: ["fixture"] });
  assert.deepEqual(legacy, { queries: ["fixture"], urls: [], focus: "" });
  assert.equal("source" in legacy, false);
  assert.equal("allowFallback" in legacy, false);

  const seenCalls = [];
  const port = {
    normalizeUrl,
    async search(query, maxResults, _signal, options) {
      seenCalls.push({ query, maxResults, options, argCount: arguments.length });
      return [];
    },
    read() { assert.fail("No read should start"); },
  };

  await research({ queries: ["legacy"] }, port, new AbortController().signal);
  await research({ queries: ["pinned"], source: "github", allowFallback: false }, port, new AbortController().signal);

  assert.deepEqual(seenCalls, [
    { query: "legacy", maxResults: 3, options: undefined, argCount: 3 },
    { query: "pinned", maxResults: 3, options: { source: "github", allowFallback: false }, argCount: 4 },
  ]);

  const invalid = await research({ queries: ["q"], source: "unknown" }, port, new AbortController().signal);
  assert.equal(invalid.status, "failed");
  assert.equal(invalid.issues[0].code, "INVALID_REQUEST");
});

test("routedSearchError classifies zero-hit attempts without misreporting primary failures as empty", () => {
  assert.equal(routedSearchError([]), undefined);
  assert.equal(routedSearchError([{ source: "host", status: "empty", dispatched: true }]), undefined);
  assert.equal(routedSearchError([
    { source: "host", status: "empty", dispatched: true },
    { source: "github", status: "rate_limited", dispatched: true },
  ]), undefined);

  const primaryAuthFallbackEmpty = routedSearchError([
    { source: "host", status: "auth_required", dispatched: true },
    { source: "github", status: "empty", dispatched: true },
  ]);
  assert.ok(primaryAuthFallbackEmpty instanceof ResearchError);
  assert.equal(primaryAuthFallbackEmpty.code, "AUTH_REQUIRED");

  assert.equal(routedSearchError([
    { source: "host", status: "auth_required", dispatched: true },
    { source: "github", status: "cooldown", dispatched: false, retryAfterMs: 1000 },
  ])?.code, "RATE_LIMITED");
  assert.equal(routedSearchError([
    { source: "host", status: "unavailable", dispatched: false },
    { source: "github", status: "timeout", dispatched: true },
  ])?.code, "TIMEOUT");
  assert.equal(routedSearchError([
    { source: "host", status: "unavailable", dispatched: false },
    { source: "github", status: "failed", dispatched: true },
  ])?.code, "SEARCH_FAILED");
});

test("citation selects multi-line RFC 8949 abstract and long single-line excerpts", async () => {
  const preamble = Array.from({ length: 45 }, (_, i) => `Section ${i}: data format notes and generic encoding details.`).join("\n");
  const rfc8949Abstract = [
    "Abstract",
    "The Concise Binary Object Representation (CBOR) is a data format whose design",
    "goals include the",
    "possibility of extremely small code size, fairly small message size, and",
    "extensibility without the",
    "need for version negotiation. These design goals make it different from earlier",
    "binary",
    "serializations such as ASN.1 and MessagePack.",
  ].join("\n");
  const document = `${preamble}\n${rfc8949Abstract}`;

  const result = await research({
    urls: ["https://www.rfc-editor.org/rfc/rfc8949.html#abstract"],
    focus: "representation data format design goals small code size extensibility without need version negotiation",
  }, {
    normalizeUrl,
    search() { assert.fail("No search should start"); },
    async read(url) {
      return { finalUrl: url, mime: "text/html", title: "RFC 8949", text: document };
    },
  }, new AbortController().signal);

  assert.equal(result.status, "completed");
  assert.match(
    result.evidence[0].quote.replace(/\s+/gu, " "),
    /(?:extensibility|extension) without (?:the need for )?version negotiation/iu,
  );
  assert.equal(document.slice(result.evidence[0].start, result.evidence[0].end), result.evidence[0].quote);

  const singleLine = `${"Introductory sentence with generic background text. ".repeat(25)}Critical target: extensibility without version negotiation is required.`;
  const longLineResult = await research({
    urls: ["https://example.org/spec"],
    focus: "extensibility without version negotiation",
  }, {
    normalizeUrl,
    search() { assert.fail("No search should start"); },
    async read(url) {
      return { finalUrl: url, mime: "text/plain", title: "Spec", text: singleLine };
    },
  }, new AbortController().signal);

  assert.equal(longLineResult.status, "completed");
  assert.match(longLineResult.evidence[0].quote, /extensibility without version negotiation/iu);
});

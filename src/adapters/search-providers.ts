import { SearchProviderError, type SearchHit, type SearchProvider, type SearchSourceId } from "../core/search-router.js";

type JsonObject = Record<string, unknown>;
type PublicSource = Exclude<SearchSourceId, "host">;
const maxResponseBytes = 384 * 1024;
const maxPublicResults = 10;
const userAgent = "SourceQuest (+https://github.com/lvy-jsd/sourcequest)";

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function text(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return;
  return value.replace(/[\u0000-\u001F\u007F\s]+/gu, " ").trim()
    .slice(0, limit).replace(/[\uD800-\uDBFF]$/u, "") || undefined;
}

function firstText(value: unknown, limit: number): string | undefined {
  return Array.isArray(value) ? text(value[0], limit) : undefined;
}

function githubHit(value: unknown): SearchHit | undefined {
  const repo = object(value);
  if (!repo || repo.private === true || typeof repo.html_url !== "string") return;
  if (!/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/u.test(repo.html_url)) return;
  const url = URL.parse(repo.html_url);
  const path = url?.pathname.split("/").slice(1) ?? [];
  if (path.length !== 2 || !path[1]) return;

  const hit: SearchHit = { url: repo.html_url, title: text(repo.full_name, 200) ?? path.join("/") };
  const description = text(repo.description, 300);
  if (description) hit.snippet = description;
  return hit;
}

function doiUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 512) return;
  if (!/^10\.\d{4,9}\/[^\s\u0000-\u001f\u007f]+$/u.test(value)) return;
  const parts = value.split("/");
  if (parts.some((part) => part === "." || part === "..")) return;
  try {
    return `https://doi.org/${parts.map(encodeURIComponent).join("/")}`;
  } catch {
    // Reject a malformed identifier without losing the other rows.
    return undefined;
  }
}

function crossrefHit(value: unknown): SearchHit | undefined {
  const work = object(value);
  if (!work) return;
  const url = doiUrl(work.DOI);
  if (!url) return;
  const hit: SearchHit = { url };
  const title = firstText(work.title, 200);
  const venue = firstText(work["container-title"], 160);
  const publisher = text(work.publisher, 120);
  if (title) hit.title = title;
  const description = [...new Set([venue, publisher].filter(Boolean))].join(" · ").slice(0, 300);
  if (description) hit.snippet = description;
  return hit;
}

function limitDelay(headers: Headers, source: PublicSource): number {
  const now = Date.now();
  const retryAfter = headers.get("retry-after")?.trim();
  const requested = retryAfter && /^\d+$/u.test(retryAfter)
    ? Number(retryAfter) * 1000
    : retryAfter ? Date.parse(retryAfter) - now : NaN;
  const reset = headers.get("x-ratelimit-reset");
  const githubReset = source === "github" && headers.get("x-ratelimit-remaining") === "0"
    && reset && /^\d+$/u.test(reset) ? Number(reset) * 1000 - now : NaN;
  const delays = [requested, githubReset].filter((ms) => Number.isSafeInteger(ms) && ms > 0);
  return delays.length ? Math.max(...delays) : source === "github" ? 60_000 : 5_000;
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new SearchProviderError("failed", "The search response had no body.");

  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  let bodyComplete = false;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) {
        bodyComplete = true;
        break;
      }
      bytes += next.value.byteLength;
      if (bytes > maxResponseBytes) throw new SearchProviderError("failed", "The search response exceeded its size limit.");
      chunks.push(decoder.decode(next.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return JSON.parse(chunks.join(""));
  } finally {
    try {
      if (!bodyComplete) await reader.cancel();
    } catch {
      // The stream may already be terminated by the caller.
    } finally {
      reader.releaseLock();
    }
  }
}

async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function fetchJson(fetcher: typeof fetch, url: URL, source: PublicSource, signal: AbortSignal): Promise<unknown> {
  try {
    const headers = new Headers({
      accept: source === "github" ? "application/vnd.github+json" : "application/json",
      "user-agent": userAgent,
    });
    if (source === "github") headers.set("x-github-api-version", "2026-03-10");
    const response = await fetcher(url, { headers, signal, redirect: "error", credentials: "omit" });
    if (response.ok) return await readJson(response, signal);

    let rateLimited = response.status === 429 || (source === "github" && response.status === 403
      && (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")));
    if (source === "github" && response.status === 403 && !rateLimited) {
      // Some secondary limits are indicated by a message alone. Read it solely for classification.
      const body = object(await readJson(response, signal).catch(() => undefined));
      rateLimited = typeof body?.message === "string" && /(?:rate limit|abuse detection)/iu.test(body.message);
    } else {
      await discardBody(response);
    }
    signal.throwIfAborted();
    if (rateLimited) {
      throw new SearchProviderError("rate_limited", "The public search source is rate-limited.", limitDelay(response.headers, source));
    }
    if (response.status === 408 || response.status === 504) {
      throw new SearchProviderError("timeout", "The public search source timed out.");
    }
    if (response.status === 401 || response.status === 403 || response.status === 503) {
      throw new SearchProviderError("unavailable", "The public search source is unavailable.");
    }
    throw new SearchProviderError("failed", "The public search source rejected the request.");
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof SearchProviderError) throw error;
    throw new SearchProviderError("failed", "The public search request did not complete.");
  }
}

function publicSource(
  id: PublicSource,
  run: (query: string, count: number, signal: AbortSignal) => Promise<SearchHit[]>,
): SearchProvider {
  let tail = Promise.resolve();
  let cooldownUntil = 0;

  return {
    id,
    async search(query, maxResults, signal) {
      signal.throwIfAborted();
      if (!Number.isFinite(maxResults) || maxResults < 1 || !query.trim()) return [];
      const count = Math.min(Math.floor(maxResults), maxPublicResults);

      // Requests already queued still observe a cooldown learned by the preceding request.
      const operation = tail.then(async () => {
        signal.throwIfAborted();
        const cooldownMs = Math.ceil(cooldownUntil - performance.now());
        if (cooldownMs > 0) throw new SearchProviderError("rate_limited", "The public search source is cooling down.", cooldownMs);
        try {
          return await run(query, count, signal);
        } catch (error) {
          if (error instanceof SearchProviderError && error.code === "rate_limited" && error.retryAfterMs) {
            cooldownUntil = performance.now() + error.retryAfterMs;
          }
          throw error;
        }
      });
      tail = operation.then(() => undefined, () => undefined);

      let abort: () => void = () => {};
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      });
      try {
        return await Promise.race([operation, cancelled]);
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
  };
}

function results(items: unknown, count: number, map: (value: unknown) => SearchHit | undefined): SearchHit[] {
  if (!Array.isArray(items)) throw new SearchProviderError("failed", "The public search source returned an invalid result envelope.");
  const hits: SearchHit[] = [];
  for (const item of items.slice(0, count)) {
    const hit = map(item);
    if (hit) hits.push(hit);
  }
  return hits;
}

export function createGithubSearch(fetcher: typeof fetch = fetch): SearchProvider {
  return publicSource("github", async (query, count, signal) => {
    const url = new URL("https://api.github.com/search/repositories");
    url.searchParams.set("q", query);
    url.searchParams.set("per_page", String(count));
    const body = object(await fetchJson(fetcher, url, "github", signal));
    return results(body?.items, count, githubHit);
  });
}

export function createCrossrefSearch(fetcher: typeof fetch = fetch): SearchProvider {
  return publicSource("crossref", async (query, count, signal) => {
    const url = new URL("https://api.crossref.org/works");
    url.searchParams.set("query.bibliographic", query);
    url.searchParams.set("rows", String(count));
    url.searchParams.set("select", "DOI,title,container-title,publisher");
    const body = object(await fetchJson(fetcher, url, "crossref", signal));
    return results(object(body?.message)?.items, count, crossrefHit);
  });
}

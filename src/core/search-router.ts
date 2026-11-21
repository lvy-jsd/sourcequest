export type SearchSourceId = "host" | "github" | "crossref";

export type SearchHit = {
  url: string;
  title?: string;
  snippet?: string;
};

export type SearchProvider = {
  id: SearchSourceId;
  search(query: string, maxResults: number, signal: AbortSignal): Promise<readonly SearchHit[]>;
};

export type SearchOptions = {
  source?: SearchSourceId | "auto";
  allowFallback?: boolean;
};

export type ProviderErrorCode = "unavailable" | "auth_required" | "rate_limited" | "timeout" | "failed";

export type SearchRouterOptions = {
  attemptTimeoutMs?: number;
};

export type SearchAttempt = {
  source: SearchSourceId;
  status: "ok" | "empty" | "cooldown" | ProviderErrorCode;
  // Records dispatch to the adapter, which might reject before an upstream call.
  dispatched: boolean;
  retryAfterMs?: number;
};

export type RoutedSearch = {
  hits: readonly SearchHit[];
  attempts: SearchAttempt[];
};

export class SearchProviderError extends Error {
  constructor(readonly code: ProviderErrorCode, message: string = code, readonly retryAfterMs?: number) {
    super(message);
    this.name = "SearchProviderError";
  }
}

const sourceIds: readonly SearchSourceId[] = ["host", "github", "crossref"];
const defaultAttemptTimeoutMs = 1_800;
const defaultCooldownMs = 30_000;

function preferredSource(query: string): SearchSourceId {
  if (/\b(?:github(?:\.com)?|repositories|repository|pull requests?)\b|开源仓库|代码仓库|源码/u.test(query.toLowerCase())) {
    return "github";
  }
  if (/\b(?:doi|crossref|arxiv|pubmed|scholarly|peer[- ]reviewed|research papers?|journal articles?)\b|论文|学术文献|期刊/u.test(query.toLowerCase())) {
    return "crossref";
  }
  return "host";
}

function cappedHits(hits: readonly SearchHit[], maxResults: number): SearchHit[] {
  const seen = new Set<string>();
  const eligible: SearchHit[] = [];
  for (const hit of hits) {
    if (typeof hit?.url !== "string") continue;
    const url = URL.parse(hit.url);
    if (url?.protocol !== "https:" || url.username || url.password) continue;

    url.hash = "";
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    const result: SearchHit = { url: url.href };
    if (typeof hit.title === "string") result.title = hit.title;
    if (typeof hit.snippet === "string") result.snippet = hit.snippet;
    eligible.push(result);
    if (eligible.length === maxResults) break;
  }
  return eligible;
}

async function invokeProvider(
  provider: SearchProvider, query: string, maxResults: number, caller: AbortSignal, attemptTimeoutMs: number,
): Promise<readonly SearchHit[]> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new SearchProviderError("timeout")), attemptTimeoutMs);
  const signal = AbortSignal.any([caller, deadline.signal]);
  let abort: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    });
    const operation = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return provider.search(query, maxResults, signal);
    });
    const hits = await Promise.race([cancelled, operation]);
    signal.throwIfAborted();
    return hits;
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
  }
}

function retryDelay(hint: number | undefined): number {
  if (hint === undefined || !Number.isFinite(hint) || hint < 0) return defaultCooldownMs;
  return Math.min(Math.max(1_000, Math.ceil(hint)), Number.MAX_SAFE_INTEGER - Date.now());
}

export class SearchRouter {
  private readonly providers = new Map<SearchSourceId, SearchProvider>();
  private readonly cooldownUntil = new Map<SearchSourceId, number>();
  private readonly attemptTimeoutMs: number;

  constructor(providers: readonly SearchProvider[], options: SearchRouterOptions = {}) {
    const timeout = options.attemptTimeoutMs ?? defaultAttemptTimeoutMs;
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new RangeError("Invalid attempt timeout.");
    }
    this.attemptTimeoutMs = timeout;
    for (const provider of providers) {
      if (this.providers.has(provider.id)) throw new Error(`Duplicate search source: ${provider.id}`);
      this.providers.set(provider.id, provider);
    }
  }

  async search(query: string, maxResults: number, signal: AbortSignal, options: SearchOptions = {}): Promise<RoutedSearch> {
    signal.throwIfAborted();
    if (!Number.isSafeInteger(maxResults) || maxResults < 0) throw new RangeError("Invalid search result limit.");
    if (!maxResults) return { hits: [], attempts: [] };

    const attempts: SearchAttempt[] = [];
    for (const source of this.route(query, options)) {
      signal.throwIfAborted();
      const provider = this.providers.get(source);
      if (!provider) {
        attempts.push({ source, status: "unavailable", dispatched: false });
        continue;
      }
      const remaining = (this.cooldownUntil.get(source) ?? 0) - Date.now();
      if (remaining > 0) {
        attempts.push({ source, status: "cooldown", dispatched: false, retryAfterMs: remaining });
        continue;
      }
      this.cooldownUntil.delete(source);

      try {
        const response = await invokeProvider(provider, query, maxResults, signal, this.attemptTimeoutMs);
        const hits = cappedHits(response, maxResults);
        attempts.push({ source, status: hits.length ? "ok" : "empty", dispatched: true });
        if (hits.length) return { hits, attempts };
      } catch (error) {
        signal.throwIfAborted();
        const status = error instanceof SearchProviderError ? error.code : "failed";
        const attempt: SearchAttempt = { source, status, dispatched: true };
        if (error instanceof SearchProviderError && status === "rate_limited") {
          const now = Date.now();
          const until = Math.max(this.cooldownUntil.get(source) ?? 0, now + retryDelay(error.retryAfterMs));
          this.cooldownUntil.set(source, until);
          attempt.retryAfterMs = until - now;
        }
        attempts.push(attempt);
      }
    }
    return { hits: [], attempts };
  }

  private route(query: string, options: SearchOptions): SearchSourceId[] {
    const source = options.source ?? "auto";
    const topicSource = preferredSource(query);
    const configured = [...new Set([topicSource, ...sourceIds])].filter((id) => this.providers.has(id));
    const fallback = options.allowFallback ?? (source === "auto");
    if (source === "auto") {
      if (!configured.length) return [topicSource];
      return fallback ? configured : configured.slice(0, 1);
    }
    return fallback ? [source, ...configured.filter((id) => id !== source)] : [source];
  }
}

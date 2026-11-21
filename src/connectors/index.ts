import { publicHttpsUrl, readPublicHttps } from "../adapters/public-https.js";
import type { ReadPage } from "../core/research.js";
import { SearchProviderError } from "../core/search-router.js";
import type {
  ConnectorItem,
  ConnectorPort,
  ConnectorQuery,
  ConnectorSyncResult,
  PortCallContext,
  SearchPort,
  SearchPortHit,
  SearchPortResult,
  SearchQueryConstraints,
} from "../ports/index.js";

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

function zeroCost(source: string) {
  return {
    kind: "actual" as const,
    currency: "USD",
    minorUnits: 0,
    source,
    recordedAt: new Date().toISOString(),
  };
}

export function createArxivConnector(fetchImpl: FetchLike = fetch): SearchPort {
  return {
    id: "arxiv",
    upstreamFamily: "arxiv-export-api",
    supportedFilters: ["dateFrom", "dateTo", "topic"],
    async search(
      query: string,
      maxResults: number,
      _constraints: SearchQueryConstraints | undefined,
      ctx: PortCallContext,
    ): Promise<SearchPortResult> {
      ctx.signal.throwIfAborted();
      const startMs = Date.now();
      const bounded = Math.max(1, Math.min(10, maxResults));
      const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${bounded}`;
      const res = await fetchImpl(url, {
        signal: ctx.signal,
        headers: { accept: "application/atom+xml,application/xml", "user-agent": "sourcequest/0.1" },
      });
      if (res.status === 429) {
        throw new SearchProviderError("rate_limited", "arXiv API rate-limited.");
      }
      if (!res.ok) {
        throw new SearchProviderError("failed", `arXiv API returned HTTP ${res.status}.`);
      }
      const xml = await res.text();
      const hits: SearchPortHit[] = [];
      const entries = xml.split(/<entry>/iu).slice(1);
      for (const entry of entries) {
        const idMatch = entry.match(/<id>\s*([^<\s]+)\s*<\/id>/iu);
        const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/iu);
        const summaryMatch = entry.match(/<summary>([\s\S]*?)<\/summary>/iu);
        const pubMatch = entry.match(/<published>\s*([^<\s]+)\s*<\/published>/iu);
        if (!idMatch) continue;
        const parsed = URL.parse(idMatch[1].replace(/^http:\/\//iu, "https://"));
        if (!parsed || parsed.protocol !== "https:") continue;
        hits.push({
          url: parsed.href,
          title: titleMatch?.[1].replace(/\s+/gu, " ").trim(),
          snippet: summaryMatch?.[1].replace(/\s+/gu, " ").trim().slice(0, 280),
          publishedAt: pubMatch?.[1],
          providerId: "arxiv",
          upstreamFamily: "arxiv-export-api",
        });
        if (hits.length >= bounded) break;
      }
      return {
        hits,
        receipt: {
          providerId: "arxiv",
          upstreamFamily: "arxiv-export-api",
          logicalRequests: 1,
          knownBackendCalls: 1,
          backendCallsUnknown: false,
          durationMs: Math.max(0, Date.now() - startMs),
          cost: zeroCost("arxiv"),
          supportedFilters: ["dateFrom", "dateTo", "topic"],
        },
      };
    },
  };
}

export function createOpenAlexConnector(fetchImpl: FetchLike = fetch): SearchPort {
  return {
    id: "openalex",
    upstreamFamily: "openalex-api",
    supportedFilters: ["dateFrom", "dateTo", "topic"],
    async search(
      query: string,
      maxResults: number,
      constraints: SearchQueryConstraints | undefined,
      ctx: PortCallContext,
    ): Promise<SearchPortResult> {
      ctx.signal.throwIfAborted();
      const startMs = Date.now();
      const bounded = Math.max(1, Math.min(10, maxResults));
      const filterParts: string[] = [];
      if (constraints?.dateFrom) filterParts.push(`from_publication_date:${constraints.dateFrom}`);
      if (constraints?.dateTo) filterParts.push(`to_publication_date:${constraints.dateTo}`);
      const filterParam = filterParts.length ? `&filter=${encodeURIComponent(filterParts.join(","))}` : "";
      const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${bounded}${filterParam}`;
      const res = await fetchImpl(url, {
        signal: ctx.signal,
        headers: { accept: "application/json", "user-agent": "sourcequest/0.1" },
      });
      if (res.status === 429) throw new SearchProviderError("rate_limited", "OpenAlex API rate-limited.");
      if (!res.ok) throw new SearchProviderError("failed", `OpenAlex API returned HTTP ${res.status}.`);
      const data = (await res.json()) as {
        results?: { id?: string; doi?: string; title?: string; publication_date?: string }[];
      };
      const hits: SearchPortHit[] = [];
      for (const item of data.results ?? []) {
        const candidateUrl = item.doi ?? item.id;
        if (!candidateUrl) continue;
        const parsed = URL.parse(candidateUrl);
        if (!parsed || parsed.protocol !== "https:") continue;
        hits.push({
          url: parsed.href,
          title: item.title,
          publishedAt: item.publication_date ? `${item.publication_date}T00:00:00.000Z` : undefined,
          rawTimeText: item.publication_date,
          providerId: "openalex",
          upstreamFamily: "openalex-api",
        });
      }
      return {
        hits: hits.slice(0, bounded),
        receipt: {
          providerId: "openalex",
          upstreamFamily: "openalex-api",
          logicalRequests: 1,
          knownBackendCalls: 1,
          backendCallsUnknown: false,
          durationMs: Math.max(0, Date.now() - startMs),
          cost: zeroCost("openalex"),
          supportedFilters: ["dateFrom", "dateTo", "topic"],
        },
      };
    },
  };
}

export function createChineseFeedConnector(
  feedUrls: readonly string[] = [],
  reader: (url: string, signal: AbortSignal) => Promise<ReadPage> = readPublicHttps,
): SearchPort {
  return {
    id: "cn-feeds",
    upstreamFamily: "rss-atom-jsonfeed",
    supportedFilters: ["domains", "language", "topic"],
    async search(
      query: string,
      maxResults: number,
      _constraints: SearchQueryConstraints | undefined,
      ctx: PortCallContext,
    ): Promise<SearchPortResult> {
      ctx.signal.throwIfAborted();
      const startMs = Date.now();
      const hits: SearchPortHit[] = [];
      const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
      let calls = 0;

      for (const feedUrl of feedUrls.slice(0, 5)) {
        ctx.signal.throwIfAborted();
        const safeUrl = publicHttpsUrl(feedUrl).href;
        calls += 1;
        const page = await reader(safeUrl, ctx.signal);
        const lines = page.text.split("\n").map((l) => l.trim()).filter(Boolean);
        for (const line of lines) {
          const urlMatch = line.match(/https:\/\/[^\s<>"]+/u);
          if (!urlMatch) continue;
          const lowerLine = line.toLowerCase();
          if (terms.length === 0 || terms.some((t) => lowerLine.includes(t))) {
            hits.push({
              url: publicHttpsUrl(urlMatch[0]).href,
              title: page.title || "Feed item",
              snippet: line.slice(0, 240),
              providerId: "cn-feeds",
              upstreamFamily: "rss-atom-jsonfeed",
            });
            if (hits.length >= maxResults) break;
          }
        }
        if (hits.length >= maxResults) break;
      }

      return {
        hits: hits.slice(0, maxResults),
        receipt: {
          providerId: "cn-feeds",
          upstreamFamily: "rss-atom-jsonfeed",
          logicalRequests: Math.max(1, calls),
          knownBackendCalls: calls,
          backendCallsUnknown: false,
          durationMs: Math.max(0, Date.now() - startMs),
          cost: zeroCost("cn-feeds"),
          supportedFilters: ["domains", "language", "topic"],
        },
      };
    },
  };
}

export function createXCapabilityConnector(options?: {
  hasCredential?: () => boolean;
  searchImpl?: (query: string, maxResults: number, signal: AbortSignal) => Promise<SearchPortHit[]>;
}): SearchPort {
  return {
    id: "x-search",
    upstreamFamily: "x-platform-api",
    supportedFilters: ["dateFrom", "dateTo", "language", "topic"],
    async search(
      query: string,
      maxResults: number,
      _constraints: SearchQueryConstraints | undefined,
      ctx: PortCallContext,
    ): Promise<SearchPortResult> {
      ctx.signal.throwIfAborted();
      const startMs = Date.now();
      if (!options?.hasCredential?.() || !options?.searchImpl) {
        throw new SearchProviderError(
          "auth_required",
          "X search capability requires configured credentials in the host environment.",
        );
      }
      const hits = await options.searchImpl(query, maxResults, ctx.signal);
      return {
        hits: hits.slice(0, maxResults),
        receipt: {
          providerId: "x-search",
          upstreamFamily: "x-platform-api",
          logicalRequests: 1,
          backendCallsUnknown: true,
          durationMs: Math.max(0, Date.now() - startMs),
          cost: {
            kind: "unknown",
            currency: "USD",
            source: "x-search",
            recordedAt: new Date().toISOString(),
          },
          supportedFilters: ["dateFrom", "dateTo", "language", "topic"],
        },
      };
    },
  };
}

export type CollabPlatform = "telegram" | "discord" | "feishu" | "notion";

export type CollabTransport = {
  fetchPage(params: {
    platform: CollabPlatform;
    owner: string;
    cursor?: string;
    limit: number;
    signal: AbortSignal;
  }): Promise<{
    items: readonly ConnectorItem[];
    nextCursor?: string;
    authRevoked?: boolean;
    gap?: { from: string; to: string; reason: string };
  }>;
};

export function createCollabConnector(platform: CollabPlatform, transport?: CollabTransport): ConnectorPort {
  return {
    id: platform,
    requiresAuth: true,
    async sync(query: ConnectorQuery, ctx: PortCallContext): Promise<ConnectorSyncResult> {
      ctx.signal.throwIfAborted();
      if (!transport || !query.authTokenRef) {
        return {
          connectorId: platform,
          items: [],
          unrecoverableGaps: [],
          authRevoked: false,
          limitations: [`${platform} connector requires user authorization token reference.`],
        };
      }
      const page = await transport.fetchPage({
        platform,
        owner: ctx.identity.owner,
        cursor: query.cursor,
        limit: query.limit,
        signal: ctx.signal,
      });
      if (page.authRevoked) {
        return {
          connectorId: platform,
          items: [],
          unrecoverableGaps: page.gap ? [page.gap] : [],
          authRevoked: true,
          limitations: [`Authorization was revoked for ${platform}; sync halted.`],
        };
      }
      return {
        connectorId: platform,
        items: page.items,
        nextCursor: page.nextCursor,
        unrecoverableGaps: page.gap ? [page.gap] : [],
        authRevoked: false,
        limitations: page.gap ? [`Unrecoverable gap recorded: ${page.gap.reason}`] : [],
      };
    },
  };
}

export function createLivestreamConnector(transport?: {
  pollWindow(params: { cursor?: string; limit: number; signal: AbortSignal }): Promise<{
    segments: readonly ConnectorItem[];
    nextCursor?: string;
    outageGap?: { from: string; to: string; reason: string };
  }>;
}): ConnectorPort {
  return {
    id: "livestream",
    requiresAuth: false,
    async sync(query: ConnectorQuery, ctx: PortCallContext): Promise<ConnectorSyncResult> {
      ctx.signal.throwIfAborted();
      if (!transport) {
        return {
          connectorId: "livestream",
          items: [],
          unrecoverableGaps: [],
          limitations: ["Livestream recorder transport (Streamlink/FFmpeg) is not attached in this environment."],
        };
      }
      const res = await transport.pollWindow({
        cursor: query.cursor,
        limit: query.limit,
        signal: ctx.signal,
      });
      const seenIds = new Set<string>();
      const deduped = res.segments.filter((s) => {
        if (seenIds.has(s.itemId)) return false;
        seenIds.add(s.itemId);
        return true;
      });
      return {
        connectorId: "livestream",
        items: deduped,
        nextCursor: res.nextCursor,
        unrecoverableGaps: res.outageGap ? [res.outageGap] : [],
        limitations: res.outageGap
          ? [`Livestream outage without replay window: ${res.outageGap.from} -> ${res.outageGap.to}`]
          : [],
      };
    },
  };
}

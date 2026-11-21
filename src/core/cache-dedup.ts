import { snapshotHash } from "./snapshot-store.js";

export type CacheScope = "public" | "authenticated";

export type CacheKeyInput = {
  owner: string;
  authContext: CacheScope;
  canonicalUrl: string;
  extractorVersion: string;
  constraintsDigest?: string;
};

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
  authContext: CacheScope;
  ownerHash: string;
};

export function canonicalizeUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = "";
  const trackingParams = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"];
  for (const param of trackingParams) {
    url.searchParams.delete(param);
  }
  const sorted = new URLSearchParams([...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b)));
  url.search = sorted.toString();
  return url.href;
}

export class ResponseCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(private readonly defaultTtlMs = 5 * 60_000, private readonly maxEntries = 512) {}

  private makeKey(input: CacheKeyInput): { key: string; ownerHash: string } {
    const ownerHash = input.authContext === "public" ? "public" : snapshotHash(input.owner);
    const key = snapshotHash(
      JSON.stringify([
        ownerHash,
        input.authContext,
        input.canonicalUrl,
        input.extractorVersion,
        input.constraintsDigest ?? "",
      ]),
    );
    return { key, ownerHash };
  }

  get(input: CacheKeyInput, forceRefresh = false, nowMs = Date.now()): T | undefined {
    if (forceRefresh) return undefined;
    const { key, ownerHash } = this.makeKey(input);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= nowMs) {
      this.entries.delete(key);
      return undefined;
    }
    if (entry.authContext !== input.authContext || entry.ownerHash !== ownerHash) {
      return undefined;
    }
    return entry.value;
  }

  set(input: CacheKeyInput, value: T, ttlMs = this.defaultTtlMs, nowMs = Date.now()): void {
    const { key, ownerHash } = this.makeKey(input);
    if (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey) this.entries.delete(oldestKey);
    }
    this.entries.set(key, {
      value,
      expiresAt: nowMs + Math.max(0, ttlMs),
      authContext: input.authContext,
      ownerHash,
    });
  }

  clearOwner(owner: string): void {
    const targetHash = snapshotHash(owner);
    for (const [k, v] of this.entries.entries()) {
      if (v.ownerHash === targetHash) this.entries.delete(k);
    }
  }
}

export class HostBackoffTracker {
  private readonly blockedUntil = new Map<string, number>();
  private readonly failures = new Map<string, number>();

  isCoolingDown(hostOrFamily: string, nowMs = Date.now()): { cooling: boolean; retryAfterMs: number } {
    const until = this.blockedUntil.get(hostOrFamily) ?? 0;
    const rem = until - nowMs;
    if (rem > 0) return { cooling: true, retryAfterMs: rem };
    this.blockedUntil.delete(hostOrFamily);
    return { cooling: false, retryAfterMs: 0 };
  }

  recordFailure(hostOrFamily: string, retryAfterMs?: number, nowMs = Date.now()): number {
    const count = (this.failures.get(hostOrFamily) ?? 0) + 1;
    this.failures.set(hostOrFamily, count);
    const exponential = Math.min(300_000, 1_500 * 2 ** Math.min(count - 1, 7));
    const waitMs =
      typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
        ? Math.max(1_000, Math.ceil(retryAfterMs))
        : exponential;
    const until = Math.max(this.blockedUntil.get(hostOrFamily) ?? 0, nowMs + waitMs);
    this.blockedUntil.set(hostOrFamily, until);
    return until - nowMs;
  }

  recordSuccess(hostOrFamily: string): void {
    this.failures.delete(hostOrFamily);
    this.blockedUntil.delete(hostOrFamily);
  }
}

export type DeduplicatedItem<T> = {
  item: T;
  independentCorroboration: boolean;
  duplicateOf?: string;
};

export function deduplicateByContentAndFamily<T extends { sourceId: string; upstreamFamily: string; contentHash: string }>(
  items: readonly T[],
): DeduplicatedItem<T>[] {
  const seenContent = new Map<string, string>();
  const seenFamilies = new Map<string, string>();
  return items.map((item) => {
    const dupContent = seenContent.get(item.contentHash);
    if (dupContent) {
      return { item, independentCorroboration: false, duplicateOf: dupContent };
    }
    seenContent.set(item.contentHash, item.sourceId);

    const dupFamily = seenFamilies.get(item.upstreamFamily);
    if (dupFamily) {
      return { item, independentCorroboration: false, duplicateOf: dupFamily };
    }
    seenFamilies.set(item.upstreamFamily, item.sourceId);

    return { item, independentCorroboration: true };
  });
}

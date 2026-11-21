import { snapshotHash } from "./snapshot-store.js";
import { z } from "zod";
import { schemaVersion } from "./contracts.js";
import type { SearchAttempt, SearchHit, SearchOptions } from "./search-router.js";

const queryLimit = 3;
const pageLimit = 3;
const resultsPerQuery = 3;
const operationTimeoutMs = 6500;
const excerptLimit = 850;

export const searchSourceSchema = z.enum(["auto", "host", "github", "crossref"]);

export const researchRequestSchema = z.strictObject({
  queries: z.array(z.string().trim().min(1).max(250)).max(queryLimit).default([]),
  urls: z.array(z.string().trim().min(1).max(2048)).max(pageLimit).default([]),
  focus: z.string().trim().max(250).default(""),
  source: searchSourceSchema.optional(),
  allowFallback: z.boolean().optional(),
}).refine(({ queries, urls }) => queries.length > 0 || urls.length > 0);

export type ResearchInput = z.infer<typeof researchRequestSchema>;

export type ReadPage = { finalUrl: string; mime: string; title: string; text: string };
export type ResearchPort = {
  search(
    query: string,
    maxResults: number,
    signal: AbortSignal,
    options?: SearchOptions,
  ): Promise<readonly SearchHit[]>;
  read(url: string, signal: AbortSignal): Promise<ReadPage>;
  normalizeUrl(url: string): string;
  saveSnapshot?(digest: string, text: string): void;
};

const failureCodeSchema = z.enum([
  "INVALID_REQUEST", "READ_FAILED", "SEARCH_FAILED", "AUTH_REQUIRED", "RATE_LIMITED",
  "UNSUPPORTED_MIME", "BUDGET_EXHAUSTED", "UNUSABLE_BODY", "EMPTY_RESULT", "TIMEOUT",
  "STORAGE_FAILED", "OUTCOME_UNKNOWN",
]);
type FailureCode = z.infer<typeof failureCodeSchema>;

export class ResearchError extends Error {
  constructor(readonly code: FailureCode, message: string) {
    super(message);
  }
}

export function routedSearchError(attempts: readonly SearchAttempt[]): ResearchError | undefined {
  if (attempts.length === 0 || attempts[0].status === "empty") return undefined;
  const failures = attempts.filter((attempt) => attempt.status !== "empty" && attempt.status !== "ok");
  if (failures.length === 0) return undefined;
  if (failures.some((attempt) => attempt.status === "rate_limited" || attempt.status === "cooldown")) {
    return new ResearchError("RATE_LIMITED", "The search sources are currently rate-limited.");
  }
  if (failures.some((attempt) => attempt.status === "timeout")) {
    return new ResearchError("TIMEOUT", "The search request timed out.");
  }
  if (failures.some((attempt) => attempt.status === "auth_required")) {
    return new ResearchError("AUTH_REQUIRED", "The configured DSH search provider needs credentials.");
  }
  return new ResearchError("SEARCH_FAILED", "The search sources failed or are unavailable.");
}

const issueSchema = z.strictObject({
  phase: z.enum(["input", "search", "read"]),
  index: z.int().nonnegative(),
  code: failureCodeSchema,
  summary: z.string().max(512),
});
type Issue = z.infer<typeof issueSchema>;

export type CheckpointValue = z.infer<ReturnType<typeof z.json>>;
export type Reservation = "run" | "unknown" | "exhausted" | { receipt: CheckpointValue };
export type ResearchCheckpoints = {
  reserve(stepId: string): Promise<Reservation>;
  settle(stepId: string, receipt: CheckpointValue): Promise<void>;
};
type StepResult<T> = { value: T } | { issue: Issue };

const sourceSchema = z.strictObject({
  url: z.url(),
  title: z.string().max(200),
  snippet: z.string().max(280),
});

const evidenceSchema = z.strictObject({
  requestedUrl: z.url(),
  finalUrl: z.url(),
  title: z.string().max(200),
  fetchedAt: z.iso.datetime(),
  mime: z.string().min(1),
  snapshotHash: z.hash("sha256"),
  coordinateSpace: z.literal("normalized-text-v1-utf16"),
  start: z.int().nonnegative(),
  end: z.int().positive(),
  quote: z.string().min(1).max(excerptLimit),
  snapshotSaved: z.boolean(),
}).refine(({ start, end, quote }) => end - start === quote.length);

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

function segmentWords(text: string): string[] {
  return [...wordSegmenter.segment(text.toLowerCase())]
    .filter((piece) => piece.isWordLike)
    .map((piece) => piece.segment);
}

function matchFocusTokens(lowerText: string, words: readonly string[]): number[] {
  const asciiWords = new Set(lowerText.match(/[a-z0-9]+/gu) ?? []);
  const matched: number[] = [];
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (/^[a-z0-9]+$/u.test(word)) {
      if (asciiWords.has(word)) matched.push(index);
    } else if (lowerText.includes(word)) {
      matched.push(index);
    }
  }
  return matched;
}

function selectQuoteStart(document: string, focus: string): number {
  const focusTokens = segmentWords(focus);
  const words = [...new Set(focusTokens)];
  if (!words.length) return 0;

  const chunks: { offset: number; text: string; lower: string; matched: number[] }[] = [];
  let offset = 0;
  for (const line of document.split("\n")) {
    if (line.length <= excerptLimit) {
      const lower = line.toLowerCase();
      chunks.push({ offset, text: line, lower, matched: matchFocusTokens(lower, words) });
    } else {
      let subStart = 0;
      for (const match of line.matchAll(/(?<=[.!?。！？])\s+/gu)) {
        const splitAt = (match.index ?? 0) + match[0].length;
        if (splitAt - subStart >= 120) {
          const slice = line.slice(subStart, splitAt);
          const lower = slice.toLowerCase();
          chunks.push({ offset: offset + subStart, text: slice, lower, matched: matchFocusTokens(lower, words) });
          subStart = splitAt;
        }
      }
      const tail = line.slice(subStart);
      const lower = tail.toLowerCase();
      chunks.push({ offset: offset + subStart, text: tail, lower, matched: matchFocusTokens(lower, words) });
    }
    offset += line.length + 1;
  }

  const df = new Float64Array(words.length);
  for (const chunk of chunks) {
    for (const tokenIndex of chunk.matched) df[tokenIndex]++;
  }
  const idf = words.map((_, tokenIndex) => Math.log(1 + chunks.length / (1 + df[tokenIndex])));

  const wordIndex = new Map(words.map((word, index) => [word, index]));
  const bigrams: { pattern: RegExp | null; raw: string[]; bonus: number }[] = [];
  for (let i = 0; i + 1 < focusTokens.length; i++) {
    const a = focusTokens[i];
    const b = focusTokens[i + 1];
    if (a === b) continue;
    const bonus = 0.5 * (idf[wordIndex.get(a)!] + idf[wordIndex.get(b)!]);
    const isAsciiPair = /^[a-z0-9]+$/u.test(a) && /^[a-z0-9]+$/u.test(b);
    bigrams.push({
      pattern: isAsciiPair ? new RegExp(`(?:^|[^a-z0-9])${a} ${b}(?=$|[^a-z0-9])`, "u") : null,
      raw: isAsciiPair ? [] : [`${a}${b}`, `${a} ${b}`],
      bonus,
    });
  }

  let start = 0;
  let bestScore = -1;
  let bestStartScore = -1;

  for (let i = 0; i < chunks.length; i++) {
    if (!chunks[i].matched.length) continue;
    const winStart = chunks[i].offset;
    const winEnd = winStart + excerptLimit;
    const bestDecay = new Float64Array(words.length);

    for (let j = i; j < chunks.length && chunks[j].offset < winEnd; j++) {
      const chunk = chunks[j];
      const decay = 1 - 0.15 * ((chunk.offset - winStart) / excerptLimit);
      const remaining = winEnd - chunk.offset;
      const hits = chunk.text.length <= remaining
        ? chunk.matched
        : matchFocusTokens(chunk.lower.slice(0, remaining), words);
      for (const tokenIndex of hits) {
        if (decay > bestDecay[tokenIndex]) bestDecay[tokenIndex] = decay;
      }
    }

    let score = 0;
    for (let t = 0; t < words.length; t++) score += bestDecay[t] * idf[t];

    if (bigrams.length) {
      const windowNorm = document.slice(winStart, winEnd).replace(/\s+/gu, " ").toLowerCase();
      for (const { pattern, raw, bonus } of bigrams) {
        if (pattern ? pattern.test(windowNorm) : raw.some((phrase) => windowNorm.includes(phrase))) {
          score += bonus;
        }
      }
    }

    let startScore = 0;
    for (const tokenIndex of chunks[i].matched) startScore += idf[tokenIndex];

    if (score > bestScore || (score === bestScore && startScore > bestStartScore)) {
      bestScore = score;
      bestStartScore = startScore;
      start = winStart;
    }
  }
  return start;
}

function citation(url: string, page: ReadPage, focus: string, save?: ResearchPort["saveSnapshot"]) {
  const document = page.text.replace(/\r\n?/gu, "\n").split("\n")
    .map((line) => line.replace(/[^\S\n]+/gu, " ").trim()).filter(Boolean).join("\n");
  if (!document) throw new ResearchError("UNUSABLE_BODY", "The page had no readable text.");
  const start = selectQuoteStart(document, focus);
  let quote = document.slice(start, start + excerptLimit).trimEnd();
  // Preserve UTF-16 coordinates without returning half of a surrogate pair.
  quote = quote.replace(/[\uD800-\uDBFF]$/u, "");
  const digest = snapshotHash(document);
  let snapshotSaved = false;
  if (save) {
    try {
      save(digest, document);
      snapshotSaved = true;
    } catch {
      // Keep a usable inline quote if the local store is unavailable or full.
    }
  }
  return evidenceSchema.parse({
    requestedUrl: url, finalUrl: page.finalUrl, mime: page.mime, title: page.title.slice(0, 200),
    fetchedAt: new Date().toISOString(),
    snapshotHash: digest, snapshotSaved,
    coordinateSpace: "normalized-text-v1-utf16",
    start, end: start + quote.length, quote,
  });
}

async function attempt<T>(
  phase: "search" | "read", index: number, caller: AbortSignal,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<StepResult<T>> {
  const deadline = AbortSignal.timeout(operationTimeoutMs);
  const signal = AbortSignal.any([caller, deadline]);
  try {
    signal.throwIfAborted();
    const value = await run(signal);
    signal.throwIfAborted();
    return { value };
  } catch (error) {
    if (caller.aborted) throw caller.reason;
    if (deadline.aborted) return { issue: { phase, index, code: "TIMEOUT", summary: "The operation timed out." } };
    if (error instanceof ResearchError) {
      return { issue: { phase, index, code: error.code, summary: error.message } };
    }
    // Provider errors can contain query strings, response bodies or tokens.
    const code = phase === "search" ? "SEARCH_FAILED" : "READ_FAILED";
    return { issue: { phase, index, code, summary: "The provider or network request failed." } };
  }
}

async function step<T>(
  phase: "search" | "read", index: number, signal: AbortSignal, schema: z.ZodType<T>,
  checkpoints: ResearchCheckpoints | undefined, run: (signal: AbortSignal) => Promise<T>,
): Promise<StepResult<T>> {
  if (!checkpoints) return attempt(phase, index, signal, run);
  signal.throwIfAborted();
  const stepId = `${phase}:${index}`;
  const decision = await checkpoints.reserve(stepId);
  signal.throwIfAborted();
  if (decision === "unknown") {
    return { issue: { phase, index, code: "OUTCOME_UNKNOWN", summary: "A previous attempt may have reached the source." } };
  }
  if (decision === "exhausted") {
    return { issue: { phase, index, code: "BUDGET_EXHAUSTED", summary: "This task has no remaining request allowance." } };
  }
  if (typeof decision === "object") {
    return z.union([z.strictObject({ value: schema }), z.strictObject({ issue: issueSchema })]).parse(decision.receipt);
  }
  const result = await attempt(phase, index, signal, run);
  await checkpoints.settle(stepId, z.json().parse(result));
  return result;
}

async function settleBatch<T>(operations: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(operations);
  return results.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
}

export async function research(
  input: unknown, port: ResearchPort, signal: AbortSignal, checkpoints?: ResearchCheckpoints,
) {
  signal.throwIfAborted();
  const parsed = researchRequestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      schemaVersion, status: "failed", sources: [], evidence: [],
      issues: [{ phase: "input", index: 0, code: "INVALID_REQUEST",
        summary: "Provide up to three non-empty queries and/or three public HTTPS URLs." }],
      omittedReadCandidates: 0,
    };
  }
  const { queries, urls, focus, source, allowFallback } = parsed.data;
  const searchOptions: SearchOptions | undefined = source !== undefined || allowFallback !== undefined
    ? {
        ...(source !== undefined ? { source } : {}),
        ...(allowFallback !== undefined ? { allowFallback } : {}),
      }
    : undefined;
  const issues: Issue[] = [];
  const candidates = new Set<string>();
  for (const [index, url] of urls.entries()) {
    try {
      candidates.add(port.normalizeUrl(url));
    } catch {
      issues.push({ phase: "input", index, code: "INVALID_REQUEST", summary: "Expected a public HTTPS hostname." });
    }
  }

  const sources = new Map<string, z.infer<typeof sourceSchema>>();
  const searchResults = await settleBatch(queries.map((query, index) =>
    step("search", index, signal, z.array(sourceSchema).max(resultsPerQuery), checkpoints, async (operationSignal) => {
      const hits = searchOptions
        ? await port.search(query, resultsPerQuery, operationSignal, searchOptions)
        : await port.search(query, resultsPerQuery, operationSignal);
      const eligible = [];
      for (const hit of hits.slice(0, resultsPerQuery)) {
        let url: string;
        try {
          url = port.normalizeUrl(hit.url);
        } catch {
          continue;
        }
        eligible.push(sourceSchema.parse({
          url, title: hit.title?.slice(0, 200) ?? "", snippet: hit.snippet?.slice(0, 280) ?? "",
        }));
      }
      return eligible;
    })));
  for (const [index, result] of searchResults.entries()) {
    if ("issue" in result) {
      issues.push(result.issue);
      continue;
    }
    for (const hit of result.value) {
      candidates.add(hit.url);
      if (!sources.has(hit.url)) sources.set(hit.url, hit);
    }
    const usable = result.value.length;
    if (!usable) issues.push({ phase: "search", index, code: "EMPTY_RESULT", summary: "No eligible HTTPS sources." });
  }

  const targets = [...candidates].slice(0, pageLimit);
  const readResults = await settleBatch(targets.map((url, index) =>
    step("read", index, signal, evidenceSchema, checkpoints, async (operationSignal) => {
      const page = await port.read(url, operationSignal);
      operationSignal.throwIfAborted();
      return citation(url, page, focus || queries.join(" "), port.saveSnapshot);
    })));
  const evidence: z.infer<typeof evidenceSchema>[] = [];
  const seenEvidence = new Set<string>();
  for (const [index, result] of readResults.entries()) {
    if ("issue" in result) {
      issues.push(result.issue);
    } else {
      if (port.saveSnapshot && !result.value.snapshotSaved) {
        issues.push({ phase: "read", index, code: "STORAGE_FAILED", summary: "The snapshot store is unavailable or full." });
      }
      if (!seenEvidence.has(result.value.finalUrl)) {
        seenEvidence.add(result.value.finalUrl);
        evidence.push(result.value);
      }
    }
  }

  signal.throwIfAborted();
  const status = evidence.length ? (issues.length ? "partial" : "completed") : sources.size ? "partial" : "failed";
  return {
    schemaVersion, status, sources: [...sources.values()], evidence, issues,
    omittedReadCandidates: candidates.size - targets.length,
  };
}

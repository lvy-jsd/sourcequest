import { snapshotHash } from "./snapshot-store.js";
import { z } from "zod";
import { schemaVersion } from "./contracts.js";

const queryLimit = 3;
const pageLimit = 3;
const resultsPerQuery = 3;
const operationTimeoutMs = 6500;
const excerptLimit = 850;

export const researchRequestSchema = z.strictObject({
  queries: z.array(z.string().trim().min(1).max(250)).max(queryLimit).default([]),
  urls: z.array(z.string().trim().min(1).max(2048)).max(pageLimit).default([]),
  focus: z.string().trim().max(250).default(""),
}).refine(({ queries, urls }) => queries.length > 0 || urls.length > 0);

export type ResearchInput = z.infer<typeof researchRequestSchema>;

export type ReadPage = { finalUrl: string; mime: string; title: string; text: string };
type SearchHit = { url: string; title?: string; snippet?: string };
type ResearchPort = {
  search(query: string, maxResults: number, signal: AbortSignal): Promise<readonly SearchHit[]>;
  read(url: string, signal: AbortSignal): Promise<ReadPage>;
  normalizeUrl(url: string): string;
  saveSnapshot?(digest: string, text: string): void;
};

type FailureCode = "INVALID_REQUEST" | "READ_FAILED" | "SEARCH_FAILED"
  | "AUTH_REQUIRED" | "RATE_LIMITED" | "UNSUPPORTED_MIME" | "BUDGET_EXHAUSTED"
  | "UNUSABLE_BODY" | "EMPTY_RESULT" | "TIMEOUT" | "STORAGE_FAILED";

export class ResearchError extends Error {
  constructor(readonly code: FailureCode, message: string) {
    super(message);
  }
}

type Issue = { phase: "input" | "search" | "read"; index: number; code: FailureCode; summary: string };

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

function citation(url: string, page: ReadPage, focus: string, save?: ResearchPort["saveSnapshot"]) {
  const document = page.text.replace(/\r\n?/gu, "\n").split("\n")
    .map((line) => line.replace(/[^\S\n]+/gu, " ").trim()).filter(Boolean).join("\n");
  if (!document) throw new ResearchError("UNUSABLE_BODY", "The page had no readable text.");
  const words = new Set([...new Intl.Segmenter(undefined, { granularity: "word" }).segment(focus.toLowerCase())]
    .filter((piece) => piece.isWordLike).map((piece) => piece.segment));
  let start = 0;
  let candidate = 0;
  let bestScore = -1;
  for (const line of document.split("\n")) {
    let score = 0;
    const sample = line.slice(0, excerptLimit).toLowerCase();
    for (const word of words) if (sample.includes(word)) score++;
    if (score > bestScore) {
      start = candidate;
      bestScore = score;
    }
    candidate += line.length + 1;
  }
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
): Promise<{ value: T } | { issue: Issue }> {
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

export async function research(input: unknown, port: ResearchPort, signal: AbortSignal) {
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
  const { queries, urls, focus } = parsed.data;
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
  const searchResults = await Promise.all(queries.map((query, index) =>
    attempt("search", index, signal, (operationSignal) => port.search(query, resultsPerQuery, operationSignal))));
  for (const [index, result] of searchResults.entries()) {
    if ("issue" in result) {
      issues.push(result.issue);
      continue;
    }
    let usable = 0;
    for (const hit of result.value.slice(0, resultsPerQuery)) {
      let url: string;
      try {
        url = port.normalizeUrl(hit.url);
      } catch {
        continue;
      }
      usable++;
      candidates.add(url);
      if (!sources.has(url)) sources.set(url, sourceSchema.parse({
        url, title: hit.title?.slice(0, 200) ?? "", snippet: hit.snippet?.slice(0, 280) ?? "",
      }));
    }
    if (!usable) issues.push({ phase: "search", index, code: "EMPTY_RESULT", summary: "No eligible HTTPS sources." });
  }

  const targets = [...candidates].slice(0, pageLimit);
  const readResults = await Promise.all(targets.map((url, index) =>
    attempt("read", index, signal, async (operationSignal) => {
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

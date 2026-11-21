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

function isAsciiAlnum(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || (c >= 65 && c <= 90);
}

function isWhitespaceCode(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 0xa0;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function trimTrailingHighSurrogate(text: string): string {
  return text.replace(/[\uD800-\uDBFF]$/u, "");
}

function normalizeDocumentText(text: string): string {
  if (!/[^\S\n ]| {2,}| \n|\n |\n\n/u.test(text)) {
    return text.trim();
  }
  return text
    .replace(/\r\n?/gu, "\n")
    .replace(/ *[^\S\n ][^\S\n]*| {2,}/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{2,}/gu, "\n")
    .trim();
}

class IntVec {
  buf: Int32Array;
  len = 0;

  constructor(initCap = 4096) {
    this.buf = new Int32Array(initCap);
  }

  push(v: number): void {
    if (this.len === this.buf.length) {
      const next = new Int32Array(this.buf.length << 1);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.len++] = v;
  }
}

function pushBoundedChunks(
  doc: string,
  segStart: number,
  segEnd: number,
  chunkStarts: IntVec,
  chunkEnds: IntVec,
): void {
  if (segEnd - segStart <= excerptLimit) {
    if (segEnd > segStart || segStart === 0) {
      chunkStarts.push(segStart);
      chunkEnds.push(segEnd);
    }
    return;
  }
  const subStep = 400;
  const searchRadius = 80;
  let pos = segStart;
  while (segEnd - pos > excerptLimit) {
    const target = pos + subStep;
    const minSplit = Math.max(pos + 120, target - searchRadius);
    const maxSplit = Math.min(segEnd - 120, target + searchRadius);
    let split = -1;

    for (let d = 0; d <= searchRadius; d++) {
      const right = target + d;
      if (right <= maxSplit && isWhitespaceCode(doc.charCodeAt(right))) {
        split = right + 1;
        while (split < segEnd - 1 && isWhitespaceCode(doc.charCodeAt(split))) split++;
        if (split >= segEnd) split = right;
        break;
      }
      const left = target - d;
      if (d > 0 && left >= minSplit && isWhitespaceCode(doc.charCodeAt(left))) {
        split = left + 1;
        while (split < segEnd - 1 && isWhitespaceCode(doc.charCodeAt(split))) split++;
        if (split >= segEnd) split = left;
        break;
      }
    }

    if (split === -1) {
      for (let d = 0; d <= searchRadius; d++) {
        const right = target + d;
        if (right <= maxSplit && !isAsciiAlnum(doc.charCodeAt(right))) {
          split = right;
          break;
        }
        const left = target - d;
        if (d > 0 && left >= minSplit && !isAsciiAlnum(doc.charCodeAt(left))) {
          split = left;
          break;
        }
      }
    }

    if (split === -1) split = target;
    if (
      split > pos
      && split < segEnd
      && isHighSurrogate(doc.charCodeAt(split - 1))
      && isLowSurrogate(doc.charCodeAt(split))
    ) {
      if (split - 1 > pos) split--;
      else if (split + 1 < segEnd) split++;
    }

    chunkStarts.push(pos);
    chunkEnds.push(split);
    pos = split;
  }
  if (pos < segEnd) {
    chunkStarts.push(pos);
    chunkEnds.push(segEnd);
  }
}

function buildChunks(document: string) {
  const initCap = Math.min(document.length + 1, 16384);
  const chunkStarts = new IntVec(initCap);
  const chunkEnds = new IntVec(initCap);
  const n = document.length;
  let lineStart = 0;
  while (lineStart <= n) {
    const nl = document.indexOf("\n", lineStart);
    const lineEnd = nl === -1 ? n : nl;
    if (lineEnd - lineStart <= excerptLimit) {
      chunkStarts.push(lineStart);
      chunkEnds.push(lineEnd);
    } else {
      const line = document.slice(lineStart, lineEnd);
      let subStart = 0;
      for (const match of line.matchAll(/(?<=[。！？])\s*|(?<=[.!?])\s+/gu)) {
        const splitAt = (match.index ?? 0) + match[0].length;
        if (splitAt - subStart >= 120) {
          pushBoundedChunks(document, lineStart + subStart, lineStart + splitAt, chunkStarts, chunkEnds);
          subStart = splitAt;
        }
      }
      if (subStart < line.length) {
        pushBoundedChunks(document, lineStart + subStart, lineEnd, chunkStarts, chunkEnds);
      }
    }
    if (nl === -1) break;
    lineStart = nl + 1;
  }
  return {
    chunkStarts: chunkStarts.buf,
    chunkEnds: chunkEnds.buf,
    numChunks: chunkStarts.len,
  };
}

function lowerBound(arr: Int32Array, len: number, target: number): number {
  let lo = 0;
  let hi = len;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function selectQuoteStart(document: string, focus: string): number {
  const focusTokens = segmentWords(focus);
  const words = [...new Set(focusTokens)];
  const wordCount = words.length;
  if (!wordCount) return 0;

  const wordIndex = new Map<string, number>();
  const asciiWordToId = new Map<string, number>();
  const singleAscii = new Int32Array(128).fill(-1);
  const singleNonAscii = new Int32Array(65536).fill(-1);
  const multiNonAsciiWords: { id: number; word: string }[] = [];
  let hasNonAsciiWords = false;

  for (let i = 0; i < wordCount; i++) {
    const w = words[i];
    wordIndex.set(w, i);
    if (/^[a-z0-9]+$/u.test(w)) {
      asciiWordToId.set(w, i);
      if (w.length === 1) singleAscii[w.charCodeAt(0)] = i;
    } else {
      hasNonAsciiWords = true;
      if (w.length === 1) singleNonAscii[w.charCodeAt(0)] = i;
      else multiNonAsciiWords.push({ id: i, word: w });
    }
  }

  const { chunkStarts, chunkEnds, numChunks } = buildChunks(document);
  if (!numChunks) return 0;

  let docForMatch = document;
  const hasUpperTurkishI = document.includes("\u0130");
  if (hasNonAsciiWords || hasUpperTurkishI) {
    docForMatch = hasUpperTurkishI
      ? document.replace(/\u0130/gu, "i").toLowerCase()
      : document.toLowerCase();
  }

  const hasMultiNonAscii = multiNonAsciiWords.length > 0;
  const multiFirstMap = hasMultiNonAscii ? new Map<number, { id: number; word: string }[]>() : null;
  const multiFirstFlag = hasMultiNonAscii ? new Uint8Array(65536) : null;
  if (hasMultiNonAscii && multiFirstFlag && multiFirstMap) {
    for (const entry of multiNonAsciiWords) {
      const first = entry.word.charCodeAt(0);
      multiFirstFlag[first] = 1;
      let bucket = multiFirstMap.get(first);
      if (!bucket) multiFirstMap.set(first, (bucket = []));
      bucket.push(entry);
    }
  }

  type NonAsciiBgTarget = { b: string; bLen: number; bChar0: number; isBAscii: boolean; bgIdx: number };
  const bigramIndexMap = new Map<number, number>();
  const bigramPairs: { aId: number; bId: number; mult: number }[] = [];
  const asciiBgByA: (Map<number, number> | undefined)[] = new Array(wordCount);
  const nonAsciiBgByA: (NonAsciiBgTarget[] | undefined)[] = new Array(wordCount);
  let hasAnyNonAsciiBg = false;

  for (let i = 0; i + 1 < focusTokens.length; i++) {
    const a = focusTokens[i];
    const b = focusTokens[i + 1];
    if (a === b) continue;
    const aId = wordIndex.get(a)!;
    const bId = wordIndex.get(b)!;
    const key = aId * wordCount + bId;
    let bgIdx = bigramIndexMap.get(key);
    if (bgIdx === undefined) {
      const isA = asciiWordToId.has(a);
      const isB = asciiWordToId.has(b);
      bgIdx = bigramPairs.length;
      bigramIndexMap.set(key, bgIdx);
      bigramPairs.push({ aId, bId, mult: 1 });
      if (isA && isB) {
        let inner = asciiBgByA[aId];
        if (!inner) asciiBgByA[aId] = (inner = new Map());
        inner.set(bId, bgIdx);
      } else {
        hasAnyNonAsciiBg = true;
        let list = nonAsciiBgByA[aId];
        if (!list) nonAsciiBgByA[aId] = (list = []);
        list.push({ b, bLen: b.length, bChar0: b.charCodeAt(0), isBAscii: isB, bgIdx });
      }
    } else {
      bigramPairs[bgIdx].mult++;
    }
  }

  const df = new Int32Array(wordCount);
  const lastChunkOfToken = new Int32Array(wordCount).fill(-1);
  const chunkHasHit = new Uint8Array(numChunks);

  const hitInitCap = Math.min(document.length + 1, 16384);
  const hitChunkVec = new IntVec(hitInitCap);
  const hitTokenVec = new IntVec(hitInitCap);
  const hitEndVec = new IntVec(hitInitCap);

  const bgCount = bigramPairs.length;
  const bgEnds = Array.from({ length: bgCount }, () => new IntVec(64));
  const bgExitChunks = Array.from({ length: bgCount }, () => new IntVec(64));

  const docLen = document.length;
  let chunkIdx = 0;
  let pos = 0;
  let prevAsciiId = -1;
  let prevAsciiStart = 0;
  let prevAsciiChunk = 0;
  let onlyWsSincePrevAscii = false;

  const checkNonAsciiBgFrom = (aId: number, aChunk: number, aStart: number, aEnd: number) => {
    const bgList = nonAsciiBgByA[aId];
    if (!bgList) return;
    let afterWs = aEnd;
    while (afterWs < docLen && isWhitespaceCode(docForMatch.charCodeAt(afterWs))) afterWs++;
    if (afterWs >= docLen) return;
    const nextChar = docForMatch.charCodeAt(afterWs);
    for (let m = 0; m < bgList.length; m++) {
      const bg = bgList[m];
      if (bg.bChar0 !== nextChar) continue;
      const bLen = bg.bLen;
      if (afterWs + bLen > docLen) continue;
      if (bLen === 1 || docForMatch.startsWith(bg.b, afterWs)) {
        if (!bg.isBAscii || afterWs + bLen === docLen || !isAsciiAlnum(docForMatch.charCodeAt(afterWs + bLen))) {
          if (afterWs + bLen - aStart <= excerptLimit) {
            bgEnds[bg.bgIdx].push(afterWs + bLen);
            bgExitChunks[bg.bgIdx].push(aChunk + 1);
          }
        }
      }
    }
  };

  while (pos < docLen) {
    while (chunkIdx < numChunks && pos >= chunkEnds[chunkIdx]) chunkIdx++;
    if (chunkIdx >= numChunks) break;

    const c = docForMatch.charCodeAt(pos);
    if (pos < chunkStarts[chunkIdx]) {
      if (!isWhitespaceCode(c)) onlyWsSincePrevAscii = false;
      pos++;
      continue;
    }

    if (hasNonAsciiWords) {
      const singleId = singleNonAscii[c];
      if (singleId !== -1) {
        if (lastChunkOfToken[singleId] !== chunkIdx) {
          lastChunkOfToken[singleId] = chunkIdx;
          df[singleId]++;
          chunkHasHit[chunkIdx] = 1;
          hitChunkVec.push(chunkIdx);
          hitTokenVec.push(singleId);
          hitEndVec.push(pos + 1);
        }
        if (hasAnyNonAsciiBg && nonAsciiBgByA[singleId]) {
          checkNonAsciiBgFrom(singleId, chunkIdx, pos, pos + 1);
        }
      }
      if (hasMultiNonAscii && multiFirstFlag![c]) {
        const bucket = multiFirstMap!.get(c)!;
        const maxEnd = Math.min(docLen, chunkStarts[chunkIdx] + excerptLimit);
        for (let k = 0; k < bucket.length; k++) {
          const entry = bucket[k];
          const wLen = entry.word.length;
          if (pos + wLen <= maxEnd && docForMatch.startsWith(entry.word, pos)) {
            const tokId = entry.id;
            if (lastChunkOfToken[tokId] !== chunkIdx) {
              lastChunkOfToken[tokId] = chunkIdx;
              df[tokId]++;
              chunkHasHit[chunkIdx] = 1;
              hitChunkVec.push(chunkIdx);
              hitTokenVec.push(tokId);
              hitEndVec.push(pos + wLen);
            }
            if (hasAnyNonAsciiBg && nonAsciiBgByA[tokId]) {
              checkNonAsciiBgFrom(tokId, chunkIdx, pos, pos + wLen);
            }
          }
        }
      }
    }

    if (isAsciiAlnum(c)) {
      const start = pos;
      let hasUpper = c >= 65 && c <= 90;
      pos++;
      while (pos < docLen) {
        const c2 = docForMatch.charCodeAt(pos);
        if ((c2 >= 97 && c2 <= 122) || (c2 >= 48 && c2 <= 57)) pos++;
        else if (c2 >= 65 && c2 <= 90) {
          hasUpper = true;
          pos++;
        } else break;
      }

      let tokId: number;
      if (pos - start === 1) {
        tokId = singleAscii[hasUpper ? (c | 32) : c];
      } else {
        const tokStr = hasUpper ? docForMatch.slice(start, pos).toLowerCase() : docForMatch.slice(start, pos);
        tokId = asciiWordToId.get(tokStr) ?? -1;
      }

      if (tokId !== -1) {
        const maxEnd = chunkStarts[chunkIdx] + excerptLimit;
        if (lastChunkOfToken[tokId] !== chunkIdx) {
          lastChunkOfToken[tokId] = chunkIdx;
          df[tokId]++;
          chunkHasHit[chunkIdx] = 1;
          hitChunkVec.push(chunkIdx);
          hitTokenVec.push(tokId);
          hitEndVec.push(pos < maxEnd ? pos : maxEnd);
        }
        if (onlyWsSincePrevAscii && prevAsciiId !== -1) {
          const bgIdx = asciiBgByA[prevAsciiId]?.get(tokId);
          if (bgIdx !== undefined && pos - prevAsciiStart <= excerptLimit) {
            bgEnds[bgIdx].push(pos);
            bgExitChunks[bgIdx].push(prevAsciiChunk + 1);
          }
        }
        if (hasAnyNonAsciiBg && nonAsciiBgByA[tokId]) {
          checkNonAsciiBgFrom(tokId, chunkIdx, start, pos);
        }
        prevAsciiId = tokId;
        prevAsciiStart = start;
        prevAsciiChunk = chunkIdx;
        onlyWsSincePrevAscii = true;
      } else {
        prevAsciiId = -1;
        onlyWsSincePrevAscii = false;
      }

      if (hasMultiNonAscii) {
        const maxEnd = Math.min(docLen, chunkStarts[chunkIdx] + excerptLimit);
        for (let p2 = start + 1; p2 < pos; p2++) {
          const c2 = docForMatch.charCodeAt(p2);
          if (multiFirstFlag![c2]) {
            const bucket2 = multiFirstMap!.get(c2)!;
            for (let k = 0; k < bucket2.length; k++) {
              const entry = bucket2[k];
              const wLen = entry.word.length;
              if (p2 + wLen <= maxEnd && docForMatch.startsWith(entry.word, p2)) {
                const tokId2 = entry.id;
                if (lastChunkOfToken[tokId2] !== chunkIdx) {
                  lastChunkOfToken[tokId2] = chunkIdx;
                  df[tokId2]++;
                  chunkHasHit[chunkIdx] = 1;
                  hitChunkVec.push(chunkIdx);
                  hitTokenVec.push(tokId2);
                  hitEndVec.push(p2 + wLen);
                }
                if (hasAnyNonAsciiBg && nonAsciiBgByA[tokId2]) {
                  checkNonAsciiBgFrom(tokId2, chunkIdx, p2, p2 + wLen);
                }
              }
            }
          }
        }
      }
      continue;
    }

    if (!isWhitespaceCode(c)) onlyWsSincePrevAscii = false;
    pos++;
  }

  const totalHits = hitChunkVec.len;
  if (!totalHits) return 0;

  const hitChunk = hitChunkVec.buf;
  const hitToken = hitTokenVec.buf;
  const hitEnd = hitEndVec.buf;

  let isEndSorted = true;
  for (let h = 1; h < totalHits; h++) {
    if (hitEnd[h] < hitEnd[h - 1]) {
      isEndSorted = false;
      break;
    }
  }

  let orderByEnd: Int32Array | null = null;
  if (!isEndSorted) {
    orderByEnd = new Int32Array(totalHits);
    if (docLen <= 2_000_000) {
      const counts = new Int32Array(docLen + 1);
      for (let h = 0; h < totalHits; h++) counts[hitEnd[h]]++;
      let sum = 0;
      for (let e = 0; e <= docLen; e++) {
        const cnt = counts[e];
        counts[e] = sum;
        sum += cnt;
      }
      for (let h = 0; h < totalHits; h++) {
        orderByEnd[counts[hitEnd[h]]++] = h;
      }
    } else {
      for (let h = 0; h < totalHits; h++) orderByEnd[h] = h;
      orderByEnd.sort((a, b) => hitEnd[a] - hitEnd[b] || a - b);
    }
  }

  const idfScale = wordCount <= 500 && document.length <= 2_000_000 ? 10000 : 100;
  const idfInt = new Float64Array(wordCount);
  for (let t = 0; t < wordCount; t++) {
    idfInt[t] = Math.round(Math.log(1 + numChunks / (1 + df[t])) * idfScale);
  }

  const bgDiff = new Float64Array(numChunks + 1);
  for (let b = 0; b < bgCount; b++) {
    const endsVec = bgEnds[b];
    const mLen = endsVec.len;
    if (!mLen) continue;
    const exitsVec = bgExitChunks[b];
    const ends = endsVec.buf;
    const exits = exitsVec.buf;
    const { aId, bId, mult } = bigramPairs[b];
    const bonusInt = Math.round(0.5 * (idfInt[aId] + idfInt[bId])) * mult;
    let prevR = 0;
    if (mLen >= numChunks / 8) {
      let lPtr = 0;
      for (let m = 0; m < mLen; m++) {
        const enterMin = ends[m] - excerptLimit;
        while (lPtr < numChunks && chunkStarts[lPtr] < enterMin) lPtr++;
        const r = exits[m];
        const l = Math.max(lPtr, prevR);
        if (l < r) {
          bgDiff[l] += bonusInt;
          bgDiff[r] -= bonusInt;
          prevR = r;
        }
      }
    } else {
      for (let m = 0; m < mLen; m++) {
        const enterMin = ends[m] - excerptLimit;
        const r = exits[m];
        let l = lowerBound(chunkStarts, r, enterMin);
        if (l < prevR) l = prevR;
        if (l < r) {
          bgDiff[l] += bonusInt;
          bgDiff[r] -= bonusInt;
          prevR = r;
        }
      }
    }
  }

  const nextHit1 = new Int32Array(totalHits);
  const lastOcc1 = new Int32Array(wordCount);
  const chunkStartScore = new Float64Array(numChunks);
  for (let h = 0; h < totalHits; h++) {
    const c = hitChunk[h];
    const t = hitToken[h];
    chunkStartScore[c] += idfInt[t];
    const prev1 = lastOcc1[t];
    if (prev1 !== 0) nextHit1[prev1 - 1] = h + 1;
    lastOcc1[t] = h + 1;
  }

  const activeHead1 = new Int32Array(wordCount);
  const activeTail1 = new Int32Array(wordCount);

  let leftHit = 0;
  let rightPtr = 0;
  let s1 = 0;
  let s2 = 0;
  let runningBg = 0;

  let bestStart = 0;
  let bestScore = -1;
  let bestStartScore = -1;

  for (let i = 0; i < numChunks; i++) {
    runningBg += bgDiff[i];
    while (leftHit < totalHits && hitChunk[leftHit] < i) {
      const t = hitToken[leftHit];
      if (activeHead1[t] === leftHit + 1) {
        const c = hitChunk[leftHit];
        s1 -= idfInt[t];
        s2 -= idfInt[t] * chunkStarts[c];
        if (activeHead1[t] === activeTail1[t]) {
          activeHead1[t] = 0;
          activeTail1[t] = 0;
        } else {
          const next1 = nextHit1[leftHit];
          activeHead1[t] = next1;
          s1 += idfInt[t];
          s2 += idfInt[t] * chunkStarts[hitChunk[next1 - 1]];
        }
      }
      leftHit++;
    }
    if (!chunkHasHit[i]) continue;

    const winStart = chunkStarts[i];
    const winEnd = winStart + excerptLimit;

    if (orderByEnd === null) {
      while (rightPtr < totalHits && hitEnd[rightPtr] <= winEnd) {
        const c = hitChunk[rightPtr];
        if (c >= i) {
          const t = hitToken[rightPtr];
          if (activeHead1[t] === 0) {
            activeHead1[t] = rightPtr + 1;
            activeTail1[t] = rightPtr + 1;
            s1 += idfInt[t];
            s2 += idfInt[t] * chunkStarts[c];
          } else {
            activeTail1[t] = rightPtr + 1;
          }
        }
        rightPtr++;
      }
    } else {
      while (rightPtr < totalHits) {
        const h = orderByEnd[rightPtr];
        if (hitEnd[h] > winEnd) break;
        const c = hitChunk[h];
        if (c >= i) {
          const t = hitToken[h];
          if (activeHead1[t] === 0) {
            activeHead1[t] = h + 1;
            activeTail1[t] = h + 1;
            s1 += idfInt[t];
            s2 += idfInt[t] * chunkStarts[c];
          } else {
            activeTail1[t] = h + 1;
          }
        }
        rightPtr++;
      }
    }

    const score = (17000 + 3 * winStart) * s1 - 3 * s2 + 17000 * runningBg;
    const startScore = chunkStartScore[i];

    if (score > bestScore || (score === bestScore && startScore > bestStartScore)) {
      bestScore = score;
      bestStartScore = startScore;
      bestStart = winStart;
    }
  }

  return bestStart;
}

function citation(url: string, page: ReadPage, focus: string, save?: ResearchPort["saveSnapshot"]) {
  const document = normalizeDocumentText(page.text);
  if (!document) throw new ResearchError("UNUSABLE_BODY", "The page had no readable text.");
  let start = selectQuoteStart(document, focus);
  if (
    start > 0
    && start < document.length
    && isHighSurrogate(document.charCodeAt(start - 1))
    && isLowSurrogate(document.charCodeAt(start))
  ) {
    start--;
  }
  let quote = document.slice(start, start + excerptLimit).trimEnd();
  // Preserve UTF-16 coordinates without returning half of a surrogate pair.
  quote = trimTrailingHighSurrogate(quote).trimEnd();
  if (!quote) throw new ResearchError("UNUSABLE_BODY", "The page had no readable text.");
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
    requestedUrl: url, finalUrl: page.finalUrl, mime: page.mime,
    title: trimTrailingHighSurrogate(page.title.slice(0, 200)),
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
          url,
          title: trimTrailingHighSurrogate(hit.title?.slice(0, 200) ?? ""),
          snippet: trimTrailingHighSurrogate(hit.snippet?.slice(0, 280) ?? ""),
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

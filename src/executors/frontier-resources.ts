import * as cheerio from "cheerio";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { publicHttpsUrl, readPublicHttps } from "../adapters/public-https.js";
import { snapshotHash } from "../core/snapshot-store.js";
import type { Anchor } from "../core/contracts.js";
import type { LlmPort, PortCallContext } from "../ports/index.js";

const execFileAsync = promisify(execFile);

async function runBinary(
  bin: string,
  args: readonly string[],
  signal?: AbortSignal,
  timeoutMs = 15_000,
): Promise<{ available: boolean; stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, [...args], {
      signal,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { available: true, stdout, stderr, exitCode: 0 };
  } catch (error: unknown) {
    const err = error as { code?: string | number; stdout?: string; stderr?: string };
    if (err?.code === "ENOENT") {
      return { available: false, stdout: "", stderr: `${bin} not found`, exitCode: 127 };
    }
    return {
      available: true,
      stdout: typeof err?.stdout === "string" ? err.stdout : "",
      stderr: typeof err?.stderr === "string" ? err.stderr : String(error),
      exitCode: typeof err?.code === "number" ? err.code : 1,
    };
  }
}

// ---------------------------------------------------------------------------
// 1. Web & Structured Data (Trafilatura / Defuddle / Crawl4AI style extraction)
// ---------------------------------------------------------------------------

export type FrontierWebExtraction = {
  canonicalUrl: string;
  title: string;
  author?: string;
  publishedAt?: string;
  markdown: string;
  links: readonly { href: string; text: string; internal: boolean }[];
  tableCount: number;
  codeBlockCount: number;
};

export function extractFrontierWebContent(html: string, baseUrl: string): FrontierWebExtraction {
  const safeBase = publicHttpsUrl(baseUrl);
  const $ = cheerio.load(html);

  const title =
    $('meta[property="og:title"]').attr("content")?.trim() ||
    $("title").first().text().trim() ||
    $("h1").first().text().trim() ||
    safeBase.hostname;

  const author =
    $('meta[name="author"]').attr("content")?.trim() ||
    $('meta[property="article:author"]').attr("content")?.trim() ||
    undefined;

  let publishedAt =
    $('meta[property="article:published_time"]').attr("content")?.trim() ||
    $('meta[name="pubdate"]').attr("content")?.trim() ||
    $("time[datetime]").first().attr("datetime")?.trim() ||
    undefined;

  const canonicalHref = $('link[rel="canonical"]').attr("href");
  let canonicalUrl = safeBase.href;
  if (canonicalHref) {
    try {
      canonicalUrl = publicHttpsUrl(new URL(canonicalHref, safeBase).href).href;
    } catch {
      // keep safeBase
    }
  }

  // Extract JSON-LD datePublished if metadata tags missed it.
  if (!publishedAt) {
    $('script[type="application/ld+json"]').each((_i, el) => {
      if (publishedAt) return;
      try {
        const parsed = JSON.parse($(el).text()) as Record<string, unknown>;
        if (typeof parsed.datePublished === "string") publishedAt = parsed.datePublished;
      } catch {
        // ignore invalid JSON-LD
      }
    });
  }

  const links: { href: string; text: string; internal: boolean }[] = [];
  const seenLinks = new Set<string>();
  $("a[href]").each((_i, el) => {
    const raw = $(el).attr("href");
    if (!raw) return;
    try {
      const resolved = publicHttpsUrl(new URL(raw, safeBase).href);
      resolved.hash = "";
      if (seenLinks.has(resolved.href)) return;
      seenLinks.add(resolved.href);
      links.push({
        href: resolved.href,
        text: $(el).text().replace(/\s+/gu, " ").trim().slice(0, 120),
        internal: resolved.hostname === safeBase.hostname,
      });
    } catch {
      // skip non-public-https links
    }
  });

  // Strip navigation, footers, scripts, styles, and high link-density sidebars.
  $("script, style, noscript, svg, nav, footer, aside, header, .sidebar, .advertisement, .ads").remove();

  const root = $("article, main, [role='main'], .post-content, .article-content").first().length
    ? $("article, main, [role='main'], .post-content, .article-content").first()
    : $("body");

  const blocks: string[] = [];
  let tableCount = 0;
  let codeBlockCount = 0;

  root.find("h1, h2, h3, h4, p, li, pre, blockquote, table").each((_i, el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === "table") {
      tableCount += 1;
      const rows: string[] = [];
      $(el).find("tr").each((rIdx, tr) => {
        const cells = $(tr)
          .find("th, td")
          .map((_c, cell) => $(cell).text().replace(/\s+/gu, " ").trim())
          .get();
        if (cells.length > 0) {
          rows.push(`| ${cells.join(" | ")} |`);
          if (rIdx === 0) rows.push(`| ${cells.map(() => "---").join(" | ")} |`);
        }
      });
      if (rows.length > 0) blocks.push(rows.join("\n"));
      return;
    }
    if (tag === "pre") {
      codeBlockCount += 1;
      blocks.push(`\`\`\`\n${$(el).text().trimEnd()}\n\`\`\``);
      return;
    }
    // Skip elements nested inside pre/table already processed.
    if ($(el).parents("table, pre").length > 0) return;

    const text = $(el).text().replace(/\s+/gu, " ").trim();
    if (!text) return;
    if (tag === "h1") blocks.push(`# ${text}`);
    else if (tag === "h2") blocks.push(`## ${text}`);
    else if (tag === "h3") blocks.push(`### ${text}`);
    else if (tag === "h4") blocks.push(`#### ${text}`);
    else if (tag === "blockquote") blocks.push(`> ${text}`);
    else if (tag === "li") blocks.push(`- ${text}`);
    else blocks.push(text);
  });

  if (blocks.length === 0) {
    const fallback = root.text().replace(/\s+/gu, " ").trim();
    if (fallback) blocks.push(fallback);
  }

  return {
    canonicalUrl,
    title,
    author,
    publishedAt,
    markdown: blocks.join("\n\n"),
    links: links.slice(0, 100),
    tableCount,
    codeBlockCount,
  };
}

// ---------------------------------------------------------------------------
// 2. Novel / Serialized Text (lncrawl / Legado small-sample probe + batch)
// ---------------------------------------------------------------------------

export type NovelRuleManifest = {
  tocUrl: string;
  title: string;
  author?: string;
  bodySelector: string;
  chapters: readonly { index: number; chapterNumber?: number; title: string; url: string }[];
  probedBy: "rule_engine" | "llm_probe";
};

export type NovelChapterRecord = {
  index: number;
  chapterNumber?: number;
  title: string;
  url: string;
  status: "verified" | "skipped_verified" | "failed";
  text: string;
  sha256: string;
};

export type NovelCrawlResult = {
  manifest: NovelRuleManifest;
  chapters: readonly NovelChapterRecord[];
  missingChapterNumbers: readonly number[];
  duplicateChapterUrls: readonly string[];
  epubSpinePreview: readonly { href: string; title: string }[];
};

const chapterPattern = /(?:第\s*(\d+)\s*[章节回卷]|chapter\s*(\d+)|\bch\.?\s*(\d+))/iu;

export async function probeNovelRules(
  tocHtml: string,
  tocUrl: string,
  llmPort?: LlmPort,
  ctx?: PortCallContext,
): Promise<NovelRuleManifest> {
  const safeToc = publicHttpsUrl(tocUrl);
  const $ = cheerio.load(tocHtml);
  const title = $("h1").first().text().trim() || $("title").first().text().trim() || "Untitled Serial";
  const author = $('meta[name="author"]').attr("content")?.trim() || undefined;

  const chapters: { index: number; chapterNumber?: number; title: string; url: string }[] = [];
  const seen = new Set<string>();

  $("a[href]").each((_i, el) => {
    const raw = $(el).attr("href");
    const label = $(el).text().replace(/\s+/gu, " ").trim();
    if (!raw || !label) return;
    let resolved: URL;
    try {
      resolved = publicHttpsUrl(new URL(raw, safeToc).href);
      resolved.hash = "";
    } catch {
      return;
    }
    if (resolved.hostname !== safeToc.hostname || seen.has(resolved.href)) return;
    const match = label.match(chapterPattern);
    if (match || /chapter|chap|read|zj/iu.test(resolved.pathname)) {
      seen.add(resolved.href);
      const numStr = match?.[1] ?? match?.[2] ?? match?.[3];
      chapters.push({
        index: chapters.length + 1,
        chapterNumber: numStr ? Number.parseInt(numStr, 10) : undefined,
        title: label.slice(0, 160),
        url: resolved.href,
      });
    }
  });

  let bodySelector = "#content, .chapter-content, article, .read-content";
  let probedBy: NovelRuleManifest["probedBy"] = "rule_engine";
  if (llmPort && ctx) {
    try {
      const llmRes = await llmPort.generate<{ bodySelector?: string }>(
        {
          role: "extractor",
          systemPrompt: 'Return JSON {"bodySelector": "<css selector>"} identifying main chapter text container.',
          userPrompt: tocHtml.slice(0, 1500),
          maxOutputTokens: 128,
        },
        ctx,
      );
      if (llmRes.parsed?.bodySelector) {
        bodySelector = llmRes.parsed.bodySelector;
        probedBy = "llm_probe";
      }
    } catch {
      // fall back to deterministic selector
    }
  }

  return {
    tocUrl: safeToc.href,
    title,
    author,
    bodySelector,
    chapters,
    probedBy,
  };
}

export async function crawlNovelChapters(params: {
  tocHtml: string;
  tocUrl: string;
  maxChapters?: number;
  priorChapterHashes?: ReadonlyMap<string, { text: string; sha256: string }>;
  fetchHtml?: (url: string, signal: AbortSignal) => Promise<string>;
  signal: AbortSignal;
}): Promise<NovelCrawlResult> {
  const manifest = await probeNovelRules(params.tocHtml, params.tocUrl);
  const fetcher = params.fetchHtml ?? (async (url, sig) => (await readPublicHttps(url, sig)).text);
  const limit = Math.min(params.maxChapters ?? manifest.chapters.length, 200);
  const chapters: NovelChapterRecord[] = [];
  const seenContentHashes = new Set<string>();
  const duplicateChapterUrls: string[] = [];

  for (const ch of manifest.chapters.slice(0, limit)) {
    params.signal.throwIfAborted();
    const prior = params.priorChapterHashes?.get(ch.url);
    if (prior) {
      seenContentHashes.add(prior.sha256);
      chapters.push({
        index: ch.index,
        chapterNumber: ch.chapterNumber,
        title: ch.title,
        url: ch.url,
        status: "skipped_verified",
        text: prior.text,
        sha256: prior.sha256,
      });
      continue;
    }

    try {
      const rawBody = await fetcher(ch.url, params.signal);
      const isHtml = /<[a-z][\s\S]*>/iu.test(rawBody);
      let cleanText = rawBody;
      if (isHtml) {
        const $ = cheerio.load(rawBody);
        $("script, style, nav, footer, .ad").remove();
        const selected = $(manifest.bodySelector).first();
        cleanText = (selected.length ? selected.text() : $("body").text())
          .replace(/\r\n?/gu, "\n")
          .replace(/[ \t]+\n/gu, "\n")
          .replace(/\n{3,}/gu, "\n\n")
          .trim();
      }
      const sha256 = snapshotHash(cleanText);
      if (seenContentHashes.has(sha256)) duplicateChapterUrls.push(ch.url);
      seenContentHashes.add(sha256);
      chapters.push({
        index: ch.index,
        chapterNumber: ch.chapterNumber,
        title: ch.title,
        url: ch.url,
        status: "verified",
        text: cleanText,
        sha256,
      });
    } catch (error) {
      if (params.signal.aborted) throw error;
      chapters.push({
        index: ch.index,
        chapterNumber: ch.chapterNumber,
        title: ch.title,
        url: ch.url,
        status: "failed",
        text: "",
        sha256: "",
      });
    }
  }

  const numbered = chapters.map((c) => c.chapterNumber).filter((n): n is number => typeof n === "number").sort((a, b) => a - b);
  const missingChapterNumbers: number[] = [];
  for (let i = 1; i < numbered.length; i++) {
    for (let missing = numbered[i - 1] + 1; missing < numbered[i]; missing++) {
      missingChapterNumbers.push(missing);
    }
  }

  return {
    manifest,
    chapters,
    missingChapterNumbers,
    duplicateChapterUrls,
    epubSpinePreview: chapters.filter((c) => c.status !== "failed").map((c) => ({
      href: `chapter-${String(c.index).padStart(4, "0")}.xhtml`,
      title: c.title,
    })),
  };
}

// ---------------------------------------------------------------------------
// 3. VOD Video, HLS (m3u8) & Subtitles (yt-dlp / N_m3u8DL-RE / WebVTT/SRT)
// ---------------------------------------------------------------------------

export type SubtitleCue = {
  startSec: number;
  endSec: number;
  text: string;
  anchor: Anchor;
};

export type VodInspectionResult = {
  pageRecognized: boolean;
  streamAvailable: boolean;
  drmEncrypted: boolean;
  fullDeliverySupported: boolean;
  streams: readonly { uri: string; bandwidth?: number; resolution?: string; durationSec?: number }[];
  subtitles: readonly SubtitleCue[];
  externalProbeUsed: "yt-dlp" | "ffprobe" | "none";
  limitations: readonly string[];
};

function parseTimestampToSec(ts: string): number {
  const clean = ts.trim().replace(",", ".");
  const parts = clean.split(":").map((p) => Number.parseFloat(p));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] ?? 0;
}

export function parseSubtitlesWithAnchors(rawSubtitles: string, snapshotDigest: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const blocks = rawSubtitles.replace(/\r\n?/gu, "\n").split(/\n{2,}/u);
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    const timeLineIdx = lines.findIndex((l) => l.includes("-->"));
    if (timeLineIdx === -1) continue;
    const [startRaw, endRaw] = lines[timeLineIdx].split("-->");
    const startSec = parseTimestampToSec(startRaw);
    const endSec = parseTimestampToSec(endRaw.split(/\s+/u)[0]);
    const text = lines.slice(timeLineIdx + 1).join(" ").trim();
    if (!text) continue;
    cues.push({
      startSec,
      endSec,
      text,
      anchor: {
        snapshotHash: snapshotDigest,
        versionKind: "normalized",
        coordinateSpace: "media-timestamp-v1",
        timestampSec: startSec,
      },
    });
  }
  return cues;
}

export function parseHlsPlaylist(m3u8Text: string, baseUrl: string): {
  drmEncrypted: boolean;
  totalDurationSec: number;
  variants: { uri: string; bandwidth?: number; resolution?: string }[];
  segments: { uri: string; durationSec: number }[];
} {
  const safeBase = publicHttpsUrl(baseUrl);
  const lines = m3u8Text.replace(/\r\n?/gu, "\n").split("\n").map((l) => l.trim()).filter(Boolean);
  let drmEncrypted = false;
  let totalDurationSec = 0;
  const variants: { uri: string; bandwidth?: number; resolution?: string }[] = [];
  const segments: { uri: string; durationSec: number }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("#EXT-X-KEY:") && !/METHOD=NONE/iu.test(line)) {
      drmEncrypted = true;
    } else if (line.startsWith("#EXT-X-STREAM-INF:") && i + 1 < lines.length && !lines[i + 1].startsWith("#")) {
      const bw = line.match(/BANDWIDTH=(\d+)/iu)?.[1];
      const res = line.match(/RESOLUTION=(\d+x\d+)/iu)?.[1];
      try {
        variants.push({
          uri: publicHttpsUrl(new URL(lines[i + 1], safeBase).href).href,
          bandwidth: bw ? Number.parseInt(bw, 10) : undefined,
          resolution: res,
        });
      } catch {
        // skip unsafe uri
      }
      i += 1;
    } else if (line.startsWith("#EXTINF:") && i + 1 < lines.length && !lines[i + 1].startsWith("#")) {
      const dur = Number.parseFloat(line.slice(8).split(",")[0]);
      const safeDur = Number.isFinite(dur) ? dur : 0;
      totalDurationSec += safeDur;
      try {
        segments.push({
          uri: publicHttpsUrl(new URL(lines[i + 1], safeBase).href).href,
          durationSec: safeDur,
        });
      } catch {
        // skip unsafe uri
      }
      i += 1;
    }
  }
  return { drmEncrypted, totalDurationSec: Number(totalDurationSec.toFixed(3)), variants, segments };
}

export async function inspectAndExtractVod(params: {
  url: string;
  m3u8Manifest?: string;
  subtitlesText?: string;
  useExternalYtDlp?: boolean;
  signal: AbortSignal;
}): Promise<VodInspectionResult> {
  const safeUrl = publicHttpsUrl(params.url);
  const limitations: string[] = [];
  let externalProbeUsed: VodInspectionResult["externalProbeUsed"] = "none";
  const streams: { uri: string; bandwidth?: number; resolution?: string; durationSec?: number }[] = [];
  let drmEncrypted = false;

  if (params.m3u8Manifest) {
    const hls = parseHlsPlaylist(params.m3u8Manifest, safeUrl.href);
    drmEncrypted = hls.drmEncrypted;
    if (hls.variants.length > 0) {
      streams.push(...hls.variants);
    } else if (hls.segments.length > 0) {
      streams.push({ uri: safeUrl.href, durationSec: hls.totalDurationSec });
    }
    if (drmEncrypted) {
      limitations.push("Encrypted EXT-X-KEY stream detected; DRM circumvention is intentionally blocked.");
    }
  }

  if (params.useExternalYtDlp) {
    const probe = await runBinary("yt-dlp", ["--dump-single-json", "--no-playlist", "--no-warnings", safeUrl.href], params.signal);
    if (probe.available && probe.exitCode === 0) {
      externalProbeUsed = "yt-dlp";
      try {
        const info = JSON.parse(probe.stdout) as { formats?: { url?: string; tbr?: number; resolution?: string }[] };
        for (const f of (info.formats ?? []).slice(0, 5)) {
          if (f.url) streams.push({ uri: f.url, bandwidth: f.tbr, resolution: f.resolution });
        }
      } catch {
        limitations.push("yt-dlp output could not be parsed cleanly.");
      }
    } else if (!probe.available) {
      limitations.push("yt-dlp CLI binary is not installed in PATH.");
    }
  }

  const subtitles = params.subtitlesText
    ? parseSubtitlesWithAnchors(params.subtitlesText, snapshotHash(params.subtitlesText))
    : [];

  return {
    pageRecognized: true,
    streamAvailable: streams.length > 0 && !drmEncrypted,
    drmEncrypted,
    fullDeliverySupported: streams.length > 0 && !drmEncrypted,
    streams,
    subtitles,
    externalProbeUsed,
    limitations,
  };
}

// ---------------------------------------------------------------------------
// 4. Software, Games & Multi-Volume Archives (aria2 / HTTP Range / Hash guard)
// ---------------------------------------------------------------------------

export type ArchiveFetchResult = {
  url: string;
  bytesDownloaded: number;
  resumedFromOffset: number;
  sha256: string;
  integrityVerified: boolean;
  missingVolumes: readonly number[];
  limitations: readonly string[];
};

export function detectMissingVolumes(filenames: readonly string[]): number[] {
  const partNumbers: number[] = [];
  for (const name of filenames) {
    const m = name.match(/(?:\.part(\d+)\.rar|\.7z\.(\d+)|\.z(\d+))$/iu);
    const num = m?.[1] ?? m?.[2] ?? m?.[3];
    if (num) partNumbers.push(Number.parseInt(num, 10));
  }
  partNumbers.sort((a, b) => a - b);
  const missing: number[] = [];
  for (let i = 1; i < partNumbers.length; i++) {
    for (let gap = partNumbers[i - 1] + 1; gap < partNumbers[i]; gap++) {
      missing.push(gap);
    }
  }
  return missing;
}

export async function verifyAndFetchArchive(params: {
  url: string;
  mirrorUrls?: readonly string[];
  existingPrefixBytes?: Uint8Array;
  expectedSha256?: string;
  siblingVolumes?: readonly string[];
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  signal: AbortSignal;
}): Promise<ArchiveFetchResult> {
  const safeUrl = publicHttpsUrl(params.url);
  const limitations: string[] = [];
  if (params.mirrorUrls && params.mirrorUrls.length > 1 && !params.expectedSha256) {
    limitations.push("Cross-mirror resume blocked until an expected SHA-256 content identity is provided.");
  }

  const fetcher = params.fetchImpl ?? fetch;
  const resumeOffset = params.existingPrefixBytes?.byteLength ?? 0;
  const headers: Record<string, string> = {};
  if (resumeOffset > 0) headers.Range = `bytes=${resumeOffset}-`;

  const resp = await fetcher(safeUrl.href, { headers, signal: params.signal });
  if (!resp.ok && resp.status !== 206) {
    throw new Error(`Archive transfer failed with HTTP ${resp.status}.`);
  }
  const tail = new Uint8Array(await resp.arrayBuffer());
  const combined = new Uint8Array(resumeOffset + tail.byteLength);
  if (params.existingPrefixBytes) combined.set(params.existingPrefixBytes, 0);
  combined.set(tail, resumeOffset);

  const sha256 = snapshotHash(combined);
  const integrityVerified = params.expectedSha256 ? sha256 === params.expectedSha256 : true;
  const missingVolumes = detectMissingVolumes(params.siblingVolumes ?? [safeUrl.pathname]);

  return {
    url: safeUrl.href,
    bytesDownloaded: combined.byteLength,
    resumedFromOffset: resumeOffset,
    sha256,
    integrityVerified,
    missingVolumes,
    limitations,
  };
}

// ---------------------------------------------------------------------------
// 5. Music & Playlists (ISRC / Duration / Chromaprint / LRC lyrics alignment)
// ---------------------------------------------------------------------------

export type MusicTrackInput = {
  title: string;
  isrc?: string;
  durationMs?: number;
  expectedTrackOrder?: number;
  actualTrackOrder?: number;
  fingerprintMatched?: boolean;
  lrcText?: string;
};

export type MusicTrackOutcome = {
  title: string;
  status: "verified_recording" | "needs_confirmation" | "metadata_only" | "failed";
  isrcValid: boolean;
  lrcCues: readonly { timestampSec: number; line: string }[];
  notes: readonly string[];
};

const isrcRegex = /^[A-Z]{2}-?[A-Z0-9]{3}-?\d{2}-?\d{5}$/iu;

export function parseLrcLyrics(lrc: string): { timestampSec: number; line: string }[] {
  const cues: { timestampSec: number; line: string }[] = [];
  for (const rawLine of lrc.split(/\r?\n/u)) {
    const match = rawLine.match(/^\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)\]\s*(.*)$/u);
    if (!match) continue;
    const min = Number.parseInt(match[1], 10);
    const sec = Number.parseFloat(match[2]);
    const text = match[3].trim();
    if (text) cues.push({ timestampSec: Number((min * 60 + sec).toFixed(3)), line: text });
  }
  return cues;
}

export function matchAndVerifyMusicPlaylist(
  tracks: readonly MusicTrackInput[],
  referenceDurationsMs?: ReadonlyMap<string, number>,
): { tracks: readonly MusicTrackOutcome[]; verifiedCount: number; needsConfirmationCount: number } {
  const outcomes: MusicTrackOutcome[] = tracks.map((t) => {
    const notes: string[] = [];
    const isrcValid = Boolean(t.isrc && isrcRegex.test(t.isrc.trim()));
    const lrcCues = t.lrcText ? parseLrcLyrics(t.lrcText) : [];
    const refDuration = t.isrc ? referenceDurationsMs?.get(t.isrc) : undefined;
    const durationOk =
      refDuration === undefined ||
      t.durationMs === undefined ||
      Math.abs(refDuration - t.durationMs) <= 2000;

    if (!durationOk) notes.push(`Duration drift exceeds 2000ms vs ISRC reference (${t.durationMs} vs ${refDuration}).`);
    if (t.expectedTrackOrder !== undefined && t.actualTrackOrder !== undefined && t.expectedTrackOrder !== t.actualTrackOrder) {
      notes.push(`Track order mismatch: expected #${t.expectedTrackOrder}, got #${t.actualTrackOrder}.`);
    }
    if (lrcCues.length > 0 && t.durationMs !== undefined) {
      const maxLyricSec = lrcCues[lrcCues.length - 1].timestampSec;
      if (maxLyricSec * 1000 > t.durationMs + 5000) {
        notes.push("LRC lyrics exceed recording duration; possible version mismatch.");
      }
    }

    let status: MusicTrackOutcome["status"] = "metadata_only";
    if (isrcValid && durationOk && t.fingerprintMatched !== false && notes.length === 0) {
      status = "verified_recording";
    } else if (notes.length > 0 || t.fingerprintMatched === false) {
      status = "needs_confirmation";
    }

    return { title: t.title, status, isrcValid, lrcCues, notes };
  });

  return {
    tracks: outcomes,
    verifiedCount: outcomes.filter((o) => o.status === "verified_recording").length,
    needsConfirmationCount: outcomes.filter((o) => o.status === "needs_confirmation").length,
  };
}

// ---------------------------------------------------------------------------
// 6. Galleries & Comics (gallery-dl / Komga / CBZ ComicInfo.xml)
// ---------------------------------------------------------------------------

export type GalleryPageItem = {
  pageNumber: number;
  url: string;
  width?: number;
  height?: number;
  sha256?: string;
  isRenderedSnapshot?: boolean;
};

export type GalleryVerificationResult = {
  seriesTitle: string;
  pages: readonly (GalleryPageItem & { assetTier: "original" | "thumbnail" | "rendered_snapshot" })[];
  missingPages: readonly number[];
  duplicateHashes: readonly string[];
  comicInfoXml: string;
};

export function inspectAndVerifyGallery(
  seriesTitle: string,
  items: readonly GalleryPageItem[],
): GalleryVerificationResult {
  const sorted = [...items].sort((a, b) => a.pageNumber - b.pageNumber);
  const seenHashes = new Set<string>();
  const duplicateHashes: string[] = [];

  const pages = sorted.map((item) => {
    publicHttpsUrl(item.url);
    if (item.sha256) {
      if (seenHashes.has(item.sha256)) duplicateHashes.push(item.sha256);
      seenHashes.add(item.sha256);
    }
    const isThumb =
      /thumb|_small|_s\.|\bw=300\b/iu.test(item.url) ||
      (item.width !== undefined && item.width < 480);
    const assetTier: "original" | "thumbnail" | "rendered_snapshot" = item.isRenderedSnapshot
      ? "rendered_snapshot"
      : isThumb
        ? "thumbnail"
        : "original";
    return { ...item, assetTier };
  });

  const missingPages: number[] = [];
  for (let i = 1; i < pages.length; i++) {
    for (let gap = pages[i - 1].pageNumber + 1; gap < pages[i].pageNumber; gap++) {
      missingPages.push(gap);
    }
  }

  const safeTitle = seriesTitle.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const comicInfoXml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    "<ComicInfo>",
    `  <Title>${safeTitle}</Title>`,
    `  <PageCount>${pages.length}</PageCount>`,
    "</ComicInfo>",
  ].join("\n");

  return { seriesTitle, pages, missingPages, duplicateHashes, comicInfoXml };
}

// ---------------------------------------------------------------------------
// 7. Academic Papers, Ebooks & Datasets (Docling/pdftotext + Hugging Face LFS)
// ---------------------------------------------------------------------------

export type PaperStructureResult = {
  rawLength: number;
  pages: readonly { page: number; text: string }[];
  formulas: readonly string[];
  tables: readonly { page: number; rows: readonly string[][] }[];
  pdftotextUsed: boolean;
  limitations: readonly string[];
};

export async function parseAcademicPaperText(params: {
  rawTextOrPages: string | readonly string[];
  pdfFilePath?: string;
  signal?: AbortSignal;
}): Promise<PaperStructureResult> {
  const limitations: string[] = [];
  let pdftotextUsed = false;
  let pageStrings: string[];

  if (params.pdfFilePath) {
    const res = await runBinary("pdftotext", ["-layout", params.pdfFilePath, "-"], params.signal);
    if (res.available && res.exitCode === 0) {
      pdftotextUsed = true;
      pageStrings = res.stdout.split("\f").filter((p) => p.trim().length > 0);
    } else {
      limitations.push("pdftotext binary unavailable or failed; falling back to supplied page text.");
      pageStrings = Array.isArray(params.rawTextOrPages) ? [...params.rawTextOrPages] : [String(params.rawTextOrPages)];
    }
  } else {
    pageStrings = Array.isArray(params.rawTextOrPages) ? [...params.rawTextOrPages] : String(params.rawTextOrPages).split("\f");
  }

  const pages = pageStrings.map((text, idx) => ({ page: idx + 1, text: text.trim() }));
  const formulas: string[] = [];
  const tables: { page: number; rows: string[][] }[] = [];

  for (const p of pages) {
    for (const m of p.text.matchAll(/\$\$([\s\S]*?)\$\$|\\begin\{equation\}([\s\S]*?)\\end\{equation\}/gu)) {
      formulas.push((m[1] ?? m[2] ?? "").trim());
    }
    const tableLines = p.text.split("\n").filter((l) => l.trim().startsWith("|") && l.trim().endsWith("|"));
    if (tableLines.length >= 2) {
      const rows = tableLines
        .filter((l) => !/^\|[\s:-|]+\|$/u.test(l.trim()))
        .map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
      if (rows.length > 0) tables.push({ page: p.page, rows });
    }
  }

  return {
    rawLength: pageStrings.join("\n").length,
    pages,
    formulas,
    tables,
    pdftotextUsed,
    limitations,
  };
}

// ---------------------------------------------------------------------------
// 8. Livestream Sliding Window & Gap Tracker (Streamlink / FFmpeg style)
// ---------------------------------------------------------------------------

export function analyzeLiveHlsWindow(params: {
  m3u8Text: string;
  baseUrl: string;
  previousLastSeq?: number;
  previousTimeIso?: string;
  nowTimeIso?: string;
}): {
  mediaSequence: number;
  lastSequence: number;
  segments: readonly { seq: number; uri: string; durationSec: number }[];
  unrecoverableGaps: readonly { from: string; to: string; missingSegments: number; reason: string }[];
} {
  const seqMatch = params.m3u8Text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/iu);
  const startSeq = seqMatch ? Number.parseInt(seqMatch[1], 10) : 0;
  const parsed = parseHlsPlaylist(params.m3u8Text, params.baseUrl);
  const segments = parsed.segments.map((s, idx) => ({ seq: startSeq + idx, ...s }));
  const unrecoverableGaps: { from: string; to: string; missingSegments: number; reason: string }[] = [];

  if (params.previousLastSeq !== undefined && startSeq > params.previousLastSeq + 1) {
    unrecoverableGaps.push({
      from: params.previousTimeIso ?? `seq-${params.previousLastSeq}`,
      to: params.nowTimeIso ?? `seq-${startSeq}`,
      missingSegments: startSeq - params.previousLastSeq - 1,
      reason: "Live sliding window advanced beyond buffer without replay history.",
    });
  }

  return {
    mediaSequence: startSeq,
    lastSequence: segments.length > 0 ? segments[segments.length - 1].seq : startSeq,
    segments,
    unrecoverableGaps,
  };
}

// ---------------------------------------------------------------------------
// 9. Podcasts & Long Audio (Podcast RSS 2.0 + whisper.cpp / ASR)
// ---------------------------------------------------------------------------

export type PodcastEpisode = {
  title: string;
  enclosureUrl: string;
  mime: string;
  durationRaw?: string;
  transcriptUrl?: string;
  chaptersUrl?: string;
};

export function parsePodcastFeedXml(rssXml: string): PodcastEpisode[] {
  const $ = cheerio.load(rssXml, { xmlMode: true });
  const episodes: PodcastEpisode[] = [];
  $("item").each((_i, el) => {
    const title = $(el).find("title").first().text().trim() || "Untitled Episode";
    const enclosureUrl = $(el).find("enclosure").attr("url")?.trim();
    const mime = $(el).find("enclosure").attr("type")?.trim() || "audio/mpeg";
    if (!enclosureUrl) return;
    try {
      const safe = publicHttpsUrl(enclosureUrl).href;
      episodes.push({
        title,
        enclosureUrl: safe,
        mime,
        durationRaw: $(el).find("itunes\\:duration, duration").first().text().trim() || undefined,
        transcriptUrl: $(el).find("podcast\\:transcript, transcript").first().attr("url")?.trim() || undefined,
        chaptersUrl: $(el).find("podcast\\:chapters, chapters").first().attr("url")?.trim() || undefined,
      });
    } catch {
      // skip non-public-https enclosures
    }
  });
  return episodes;
}

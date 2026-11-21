import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyzeLiveHlsWindow,
  crawlNovelChapters,
  detectMissingVolumes,
  extractFrontierWebContent,
  inspectAndExtractVod,
  inspectAndVerifyGallery,
  matchAndVerifyMusicPlaylist,
  parseAcademicPaperText,
  parsePodcastFeedXml,
  parseStructuredJson,
  verifyAndFetchArchive,
} from "../dist/index.js";
import { snapshotHash } from "../dist/core/snapshot-store.js";

test("parseStructuredJson strips <think> reasoning blocks emitted by local & DeepSeek models", () => {
  const output = `<think>First check constraints {"draft": true}\nNow produce final answer.</think>\n\`\`\`json\n{"subQuestions":[{"question":"Verify release v1","queries":["release v1"]}]}\n\`\`\``;
  const parsed = parseStructuredJson(output);
  assert.deepEqual(parsed, {
    subQuestions: [{ question: "Verify release v1", queries: ["release v1"] }],
  });

  const unclosedThink = `<think>Reasoning still going...`;
  assert.equal(parseStructuredJson(unclosedThink), undefined);
});

test("1. Web extraction strips boilerplate, keeps Markdown tables/code, and extracts canonical & JSON-LD metadata", () => {
  const html = `<!doctype html><html><head>
    <link rel="canonical" href="https://docs.example.org/spec?v=2">
    <meta name="author" content="Ada Lovelace">
    <script type="application/ld+json">{"datePublished":"2026-11-10T00:00:00Z"}</script>
  </head><body>
    <nav><a href="/home">Home</a><a href="https://ads.example.org/buy">Buy</a></nav>
    <main>
      <h1>SourceQuest Spec</h1>
      <p>Primary quote verification ensures traceability.</p>
      <table><tr><th>Module</th><th>Status</th></tr><tr><td>Core</td><td>Verified</td></tr></table>
      <pre>npm run check</pre>
      <a href="/guide">Guide</a>
    </main>
    <footer>Copyright 2026</footer>
  </body></html>`;
  const res = extractFrontierWebContent(html, "https://docs.example.org/raw");
  assert.equal(res.canonicalUrl, "https://docs.example.org/spec?v=2");
  assert.equal(res.author, "Ada Lovelace");
  assert.equal(res.publishedAt, "2026-11-10T00:00:00Z");
  assert.equal(res.tableCount, 1);
  assert.equal(res.codeBlockCount, 1);
  assert.match(res.markdown, /\| Module \| Status \|/);
  assert.equal(res.markdown.includes("Copyright 2026"), false);
  assert.equal(res.links.some((l) => l.href === "https://docs.example.org/guide" && l.internal), true);
});

test("2. Novel crawler probes TOC, skips already-verified chapters on resume, and flags missing chapter numbers", async () => {
  const tocHtml = `<html><head><title>星海纪元</title></head><body>
    <a href="/ch/1">第1章 启程</a>
    <a href="/ch/2">第2章 信号</a>
    <a href="/ch/4">第4章 终章</a>
  </body></html>`;
  const ch1Text = "第一章正文内容。";
  const prior = new Map([["https://novel.example.org/ch/1", { text: ch1Text, sha256: snapshotHash(ch1Text) }]]);
  const res = await crawlNovelChapters({
    tocHtml,
    tocUrl: "https://novel.example.org/toc",
    priorChapterHashes: prior,
    fetchHtml: async (url) => {
      if (url.endsWith("/2")) return "<div id='content'>第二章正文。</div>";
      return "<div id='content'>第四章正文。</div>";
    },
    signal: new AbortController().signal,
  });
  assert.equal(res.chapters.length, 3);
  assert.equal(res.chapters[0].status, "skipped_verified");
  assert.equal(res.chapters[1].status, "verified");
  assert.deepEqual(res.missingChapterNumbers, [3]);
  assert.equal(res.epubSpinePreview.length, 3);
});

test("3. VOD HLS parser & WebVTT subtitle anchoring separate stream discovery, DRM detection, and timestamps", async () => {
  const m3u8 = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1920x1080
https://cdn.example.org/1080p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480
https://cdn.example.org/480p.m3u8`;
  const vtt = `WEBVTT

00:01:02.500 --> 00:01:05.000
SourceQuest verifies citations cleanly.`;
  const vod = await inspectAndExtractVod({
    url: "https://media.example.org/master.m3u8",
    m3u8Manifest: m3u8,
    subtitlesText: vtt,
    signal: new AbortController().signal,
  });
  assert.equal(vod.streamAvailable, true);
  assert.equal(vod.drmEncrypted, false);
  assert.equal(vod.streams.length, 2);
  assert.equal(vod.subtitles[0].startSec, 62.5);
  assert.equal(vod.subtitles[0].anchor.timestampSec, 62.5);

  const drmVod = await inspectAndExtractVod({
    url: "https://media.example.org/enc.m3u8",
    m3u8Manifest: `#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.org/k"\n#EXTINF:5.0,\nseg1.ts`,
    signal: new AbortController().signal,
  });
  assert.equal(drmVod.drmEncrypted, true);
  assert.equal(drmVod.fullDeliverySupported, false);
});

test("4. Software & Archive HTTP Range resume, SHA-256 verification, and multi-volume gap checks", async () => {
  const full = new TextEncoder().encode("HEADER-PAYLOAD-TAIL");
  const prefix = full.slice(0, 7);
  const tail = full.slice(7);
  const expectedSha256 = snapshotHash(full);
  const out = await verifyAndFetchArchive({
    url: "https://dl.example.org/bundle.part1.rar",
    existingPrefixBytes: prefix,
    expectedSha256,
    siblingVolumes: ["bundle.part1.rar", "bundle.part3.rar"],
    fetchImpl: async (_url, init) => {
      assert.equal(init?.headers?.Range, "bytes=7-");
      return new Response(tail, { status: 206 });
    },
    signal: new AbortController().signal,
  });
  assert.equal(out.resumedFromOffset, 7);
  assert.equal(out.integrityVerified, true);
  assert.deepEqual(out.missingVolumes, [2]);
  assert.deepEqual(detectMissingVolumes(["pkg.7z.001", "pkg.7z.002", "pkg.7z.004"]), [3]);
});

test("5. Music playlist ISRC, duration drift, and LRC timestamp alignment verification", () => {
  const ref = new Map([["USRC17607839", 200_000]]);
  const res = matchAndVerifyMusicPlaylist(
    [
      {
        title: "Track One",
        isrc: "USRC17607839",
        durationMs: 200_500,
        expectedTrackOrder: 1,
        actualTrackOrder: 1,
        lrcText: "[00:12.50]First verified line",
      },
      {
        title: "Track Two (Wrong Version)",
        isrc: "USRC17607839",
        durationMs: 240_000,
        expectedTrackOrder: 2,
        actualTrackOrder: 3,
      },
    ],
    ref,
  );
  assert.equal(res.verifiedCount, 1);
  assert.equal(res.needsConfirmationCount, 1);
  assert.equal(res.tracks[0].lrcCues[0].timestampSec, 12.5);
});

test("6 & 7. Comics & Galleries classify originals vs thumbnails, detect missing pages, and build ComicInfo.xml", () => {
  const res = inspectAndVerifyGallery("SourceQuest Comic Vol 1", [
    { pageNumber: 1, url: "https://img.example.org/p1.png", width: 1600, sha256: "a".repeat(64) },
    { pageNumber: 3, url: "https://img.example.org/p3_thumb.jpg", width: 320, sha256: "b".repeat(64) },
  ]);
  assert.equal(res.pages[0].assetTier, "original");
  assert.equal(res.pages[1].assetTier, "thumbnail");
  assert.deepEqual(res.missingPages, [2]);
  assert.match(res.comicInfoXml, /<PageCount>2<\/PageCount>/);
});

test("8. Academic paper parser extracts page-anchored formulas and Markdown tables", async () => {
  const res = await parseAcademicPaperText({
    rawTextOrPages: [
      "Introduction\n$$\nE = mc^2\n$$\n| Metric | Score |\n| --- | --- |\n| Precision | 1.0 |",
      "Page 2 conclusion",
    ],
  });
  assert.equal(res.pages.length, 2);
  assert.deepEqual(res.formulas, ["E = mc^2"]);
  assert.equal(res.tables[0].page, 1);
  assert.equal(res.tables[0].rows[1][0], "Precision");
});

test("9 & 10. Livestream sliding window detects unrecoverable gaps and Podcast RSS parser validates enclosures", () => {
  const live = analyzeLiveHlsWindow({
    m3u8Text: "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:15\n#EXTINF:4.0,\nseg15.ts\n#EXTINF:4.0,\nseg16.ts",
    baseUrl: "https://live.example.org/stream.m3u8",
    previousLastSeq: 10,
    previousTimeIso: "2026-11-21T09:00:00Z",
    nowTimeIso: "2026-11-21T09:00:20Z",
  });
  assert.equal(live.unrecoverableGaps.length, 1);
  assert.equal(live.unrecoverableGaps[0].missingSegments, 4);

  const rss = `<?xml version="1.0"?><rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel><item><title>Ep 1</title><enclosure url="https://pod.example.org/ep1.mp3" type="audio/mpeg" /><itunes:duration>42:10</itunes:duration><podcast:transcript url="https://pod.example.org/ep1.vtt" /></item></channel></rss>`;
  const episodes = parsePodcastFeedXml(rss);
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].enclosureUrl, "https://pod.example.org/ep1.mp3");
  assert.equal(episodes[0].transcriptUrl, "https://pod.example.org/ep1.vtt");
});

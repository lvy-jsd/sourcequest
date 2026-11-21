import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
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

test("citation stays fast (<500ms) on 512 KiB dense short-line documents", async () => {
  const cases = [
    {
      name: "262k single-token lines",
      text: "a\n".repeat(262144),
      focus: "a b",
    },
    {
      name: "260k alternating lines with 26-token focus",
      text: "a\nb\n".repeat(130000),
      focus: "a b c d e f g h i j k l m n o p q r s t u v w x y z",
    },
  ];

  for (const { name, text, focus } of cases) {
    let savedDocument = "";
    const started = performance.now();
    const result = await research({ urls: ["https://example.org/dense"], focus }, {
      normalizeUrl,
      search() { assert.fail("No search should start"); },
      async read(url) {
        return { finalUrl: url, mime: "text/plain", title: name, text };
      },
      saveSnapshot(_digest, doc) {
        savedDocument = doc;
      },
    }, new AbortController().signal);
    const elapsedMs = performance.now() - started;

    assert.ok(elapsedMs < 500, `${name} took ${elapsedMs.toFixed(1)} ms (expected < 500 ms)`);
    assert.equal(result.status, "completed", name);
    assert.equal(result.evidence.length, 1, name);
    const [evidence] = result.evidence;
    assert.ok(evidence.quote.length > 0 && evidence.quote.length <= 850, name);
    assert.equal(savedDocument.slice(evidence.start, evidence.end), evidence.quote, name);
  }
});

test("citation locates targets past 850 chars in >2000-char CJK, punctuation-free, long-tail, and hard-split straddling lines", async () => {
  const cjkDoc = `${"这是一段用于填充前缀长度的普通中文背景描述文字内容。".repeat(80)}核心结论：这里记录了测试结果。后续补充说明。`;
  assert.ok(cjkDoc.length > 2000);

  const noPunctDoc = `${"background token ".repeat(125)}critical target extensibility without version negotiation here`;
  assert.ok(noPunctDoc.length > 2000);

  const longTailDoc = `${"Introductory sentence with generic background text. ".repeat(25)}${"clause padding words without period ".repeat(30)}final extensibility without version negotiation clause`;
  assert.ok(longTailDoc.length > 2200);

  const cjkStraddle400 = `${"甲".repeat(398)}独特目标词汇${"乙".repeat(1700)}`;
  assert.ok(cjkStraddle400.length > 2000);

  const cjkStraddle1200 = `${"甲".repeat(1198)}独特目标词汇${"乙".repeat(900)}`;
  assert.ok(cjkStraddle1200.length > 2000);

  const cases = [
    {
      name: "CJK single line without whitespace after full stop",
      text: cjkDoc,
      focus: "这里记录了测试结果",
      expected: "这里记录了测试结果",
      minStart: 850,
    },
    {
      name: "punctuation-free single line",
      text: noPunctDoc,
      focus: "extensibility without version negotiation",
      expected: "extensibility without version negotiation",
      minStart: 850,
    },
    {
      name: "long tail clause past last sentence break",
      text: longTailDoc,
      focus: "extensibility without version negotiation",
      expected: "extensibility without version negotiation",
      minStart: 1300,
    },
    {
      name: "unspaced CJK hard-split straddle at char 400",
      text: cjkStraddle400,
      focus: "独特目标词汇",
      expected: "独特目标词汇",
      minStart: -1,
    },
    {
      name: "unspaced CJK hard-split straddle at char 1200",
      text: cjkStraddle1200,
      focus: "独特目标词汇",
      expected: "独特目标词汇",
      minStart: 400,
    },
  ];

  for (const { name, text, focus, expected, minStart } of cases) {
    const result = await research({ urls: ["https://example.org/long-line"], focus }, {
      normalizeUrl,
      search() { assert.fail("No search should start"); },
      async read(url) {
        return { finalUrl: url, mime: "text/plain", title: name, text };
      },
    }, new AbortController().signal);

    assert.equal(result.status, "completed", name);
    const [evidence] = result.evidence;
    assert.ok(evidence.start > minStart, `${name}: expected start > ${minStart}, got ${evidence.start}`);
    assert.ok(evidence.quote.includes(expected), `${name}: quote missed "${expected}"`);
    assert.equal(text.slice(evidence.start, evidence.end), evidence.quote, name);
  }
});

test("citation preserves UTF-16 alignment across Turkish İ expansion and astral surrogate boundaries", async () => {
  const turkishDoc = `${"alpha ".padEnd(506, "x")}\n${"\u0130".repeat(200)} beta ${"x".repeat(400)}`;
  const turkishRes = await research({
    urls: ["https://example.org/turkish"],
    focus: "alpha beta",
  }, {
    normalizeUrl,
    search() { assert.fail("No search should start"); },
    async read(url) {
      return { finalUrl: url, mime: "text/plain", title: "Turkish I", text: turkishDoc };
    },
  }, new AbortController().signal);
  assert.equal(turkishRes.status, "completed");
  assert.equal(turkishRes.evidence[0].start, 0);
  assert.ok(turkishRes.evidence[0].quote.includes("alpha"));
  assert.ok(turkishRes.evidence[0].quote.includes("beta"));
  assert.equal(turkishDoc.slice(turkishRes.evidence[0].start, turkishRes.evidence[0].end), turkishRes.evidence[0].quote);

  const astralDoc = `a${"😀".repeat(600)}TARGET_ASTRAL${"𠮷".repeat(300)}`;
  const astralRes = await research({
    urls: ["https://example.org/astral"],
    focus: "TARGET_ASTRAL",
  }, {
    normalizeUrl,
    search() { assert.fail("No search should start"); },
    async read(url) {
      return { finalUrl: url, mime: "text/plain", title: `${"a".repeat(199)}😀`, text: astralDoc };
    },
  }, new AbortController().signal);
  assert.equal(astralRes.status, "completed");
  assert.ok(astralRes.evidence[0].quote.includes("TARGET_ASTRAL"));
  assert.equal(astralRes.evidence[0].quote.isWellFormed(), true);
  assert.equal(astralRes.evidence[0].title.isWellFormed(), true);
  assert.equal(astralDoc.slice(astralRes.evidence[0].start, astralRes.evidence[0].end), astralRes.evidence[0].quote);

  const edgeSurrogateDoc = `${"a".repeat(849)}😀😀😀`;
  const edgeRes = await research({
    urls: ["https://example.org/edge-surrogate"],
    focus: "nothing",
  }, {
    normalizeUrl,
    search() { assert.fail("No search should start"); },
    async read(url) {
      return { finalUrl: url, mime: "text/plain", title: "Edge", text: edgeSurrogateDoc };
    },
  }, new AbortController().signal);
  assert.equal(edgeRes.status, "completed");
  assert.equal(edgeRes.evidence[0].start, 0);
  assert.equal(edgeRes.evidence[0].end, 849);
  assert.equal(edgeRes.evidence[0].quote.length, 849);
  assert.equal(edgeRes.evidence[0].quote.isWellFormed(), true);

  const loneHighDoc = "\uD800";
  const loneRes = await research({
    urls: ["https://example.org/lone-surrogate"],
    focus: "x",
  }, {
    normalizeUrl,
    search() { assert.fail("No search should start"); },
    async read(url) {
      return { finalUrl: url, mime: "text/plain", title: "Lone", text: loneHighDoc };
    },
  }, new AbortController().signal);
  assert.equal(loneRes.status, "failed");
  assert.equal(loneRes.issues[0].code, "UNUSABLE_BODY");
});

test("citation matches Turkish İ (U+0130) in focus and queries past offset 850", async () => {
  const istanbulDoc = `${"ordinary background line.\n".repeat(45)}İstanbul target phrase.`;
  assert.ok(istanbulDoc.indexOf("İstanbul") > 850);

  const focusRes = await research({
    urls: ["https://example.org/istanbul-focus"],
    focus: "İstanbul",
  }, {
    normalizeUrl,
    search() { assert.fail("No search should start"); },
    async read(url) {
      return { finalUrl: url, mime: "text/plain", title: "Istanbul Focus", text: istanbulDoc };
    },
  }, new AbortController().signal);
  assert.equal(focusRes.status, "completed");
  assert.ok(focusRes.evidence[0].start >= 850);
  assert.ok(focusRes.evidence[0].quote.includes("İstanbul"));
  assert.equal(istanbulDoc.slice(focusRes.evidence[0].start, focusRes.evidence[0].end), focusRes.evidence[0].quote);

  const queryRes = await research({
    queries: ["İstanbul"],
  }, {
    normalizeUrl,
    async search() {
      return [{ url: "https://example.org/istanbul-query", title: "Istanbul Query" }];
    },
    async read(url) {
      return { finalUrl: url, mime: "text/plain", title: "Istanbul Query", text: istanbulDoc };
    },
  }, new AbortController().signal);
  assert.equal(queryRes.status, "completed");
  assert.ok(queryRes.evidence[0].start >= 850);
  assert.ok(queryRes.evidence[0].quote.includes("İstanbul"));
  assert.equal(istanbulDoc.slice(queryRes.evidence[0].start, queryRes.evidence[0].end), queryRes.evidence[0].quote);

  const singleCharDoc = `${"x ".repeat(600)}İ Ankara`;
  assert.ok(singleCharDoc.indexOf("İ Ankara") > 850);
  const singleCharRes = await research({
    urls: ["https://example.org/istanbul-char"],
    focus: "İ",
  }, {
    normalizeUrl,
    search() { assert.fail("No search should start"); },
    async read(url) {
      return { finalUrl: url, mime: "text/plain", title: "Single Turkish I", text: singleCharDoc };
    },
  }, new AbortController().signal);
  assert.equal(singleCharRes.status, "completed");
  assert.ok(singleCharRes.evidence[0].start > 0);
  assert.ok(singleCharRes.evidence[0].end > 850);
  assert.ok(singleCharRes.evidence[0].quote.includes("İ Ankara"));
  assert.equal(singleCharDoc.slice(singleCharRes.evidence[0].start, singleCharRes.evidence[0].end), singleCharRes.evidence[0].quote);

  const mixedDoc = `${"ordinary background line.\n".repeat(45)}İstanbul Türkiye target.`;
  const mixedRes = await research({
    urls: ["https://example.org/istanbul-mixed"],
    focus: "İstanbul Türkiye",
  }, {
    normalizeUrl,
    search() { assert.fail("No search should start"); },
    async read(url) {
      return { finalUrl: url, mime: "text/plain", title: "Mixed Turkish I", text: mixedDoc };
    },
  }, new AbortController().signal);
  assert.equal(mixedRes.status, "completed");
  assert.ok(mixedRes.evidence[0].start >= 850);
  assert.ok(mixedRes.evidence[0].quote.includes("İstanbul Türkiye"));
  assert.equal(mixedDoc.slice(mixedRes.evidence[0].start, mixedRes.evidence[0].end), mixedRes.evidence[0].quote);
});

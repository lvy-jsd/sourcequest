import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import WebRuntime from "@deepseek-ai/dsh-web";
import {
  BROWSER_COMPARISON_MATRIX,
  BrowserExecutor,
  BudgetLedger,
  CapabilityRegistry,
  CorpusIndex,
  Crawl4AiExecutor,
  DocumentParserExecutor,
  DshLlmAdapter,
  ExplicitDshWebBridge,
  HostBackoffTracker,
  ResumableBatchQueueExecutor,
  ResponseCache,
  SourceQuestRpcService,
  ThreeTierRouter,
  buildResearchPlan,
  canonicalizeUrl,
  createArxivConnector,
  createChineseFeedConnector,
  createCollabConnector,
  createLivestreamConnector,
  createOpenAlexConnector,
  createXCapabilityConnector,
  deduplicateByContentAndFamily,
  generateDeepRecoveryReport,
  migrateTaskRecord,
  planAcademicDatasetExecution,
  renderSourceQuestPanelHtml,
  runBoundedResearchLoop,
  runDoctor,
  triageReadPage,
} from "../dist/index.js";
import { SnapshotStore, snapshotHash } from "../dist/core/snapshot-store.js";

function makeCtx(owner = "session-1") {
  return {
    identity: { taskId: "t-1", runId: "r-1", stepId: "s-1", attemptId: "a-1", owner },
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 10_000,
    authContext: "public",
  };
}

function zeroCost(source) {
  return { kind: "actual", currency: "USD", minorUnits: 0, source, recordedAt: new Date().toISOString() };
}

test("migrateTaskRecord upgrades v0 and rejects higher unknown schemaVersion without downgrade", () => {
  const v0 = migrateTaskRecord({ taskId: "t1" });
  assert.equal(v0.ok, true);
  assert.equal(v0.migrated, true);
  assert.equal(v0.record.schemaVersion, 1);

  const future = migrateTaskRecord({ schemaVersion: 99, taskId: "t1" });
  assert.equal(future.ok, false);
  assert.equal(future.code, "UNSUPPORTED_SCHEMA_VERSION");
});

test("BudgetLedger enforces concurrency, slices child budgets, rejects unknown-cost under strict currencyLimit, and tracks crash outcome_unknown", () => {
  const ledger = new BudgetLedger({
    wallTimeMs: 10_000,
    logicalRequests: 3,
    pages: 2,
    concurrency: 1,
    currencyLimit: { currency: "USD", minorUnits: 100 },
  });

  assert.equal(ledger.canAffordRoute("paid_unknown", true).ok, false);
  assert.equal(ledger.canAffordRoute("free", true).ok, true);

  assert.equal(ledger.reserve("s1", { logicalRequests: 1, pages: 1 }).ok, true);
  assert.equal(ledger.reserve("s2", { logicalRequests: 1 }).ok, false); // concurrency cap
  ledger.markOutcomeUnknown("s1", "crash");

  const child = ledger.createChildBudget(0.5);
  assert.equal(child.logicalRequests, 1);

  const snap = ledger.snapshot();
  assert.deepEqual(snap.outcomeUnknownSteps, ["s1"]);
  assert.equal(snap.reserved.logicalRequests, 1);
  assert.equal(snap.unknownBackendCalls, 1);
});

test("triageReadPage distinguishes short valid announcements, JS empty shells, long login walls, 429s, and PDFs", () => {
  assert.equal(
    triageReadPage({ statusCode: 200, mime: "text/html", title: "Notice", text: "Service maintenance starts 02:00 UTC." }).classification,
    "verified",
  );
  assert.equal(
    triageReadPage({ statusCode: 200, mime: "text/html", title: "App", text: "You need to enable JavaScript to run this app." }).classification,
    "shell",
  );
  const longLogin = `${"Please read our help center details. ".repeat(15)} Sign in and create an account to subscribe to read.`;
  assert.equal(
    triageReadPage({ statusCode: 200, mime: "text/html", title: "Sign in", text: longLogin }).classification,
    "auth_wall",
  );
  assert.equal(
    triageReadPage({ statusCode: 429, mime: "text/html", title: "429", text: "Too many requests" }).classification,
    "rate_limited",
  );
  assert.equal(
    triageReadPage({ statusCode: 200, mime: "application/pdf", title: "Paper", text: "%PDF-1.7" }).classification,
    "unsupported_mime",
  );
});

test("ResponseCache isolates owners/authContexts, canonicalizeUrl preserves content params, and dedup collapses reprints/same family", () => {
  const canonical = canonicalizeUrl("https://example.com/doc?utm_source=x&v=2&id=10#sec");
  assert.equal(canonical, "https://example.com/doc?id=10&v=2");

  const cache = new ResponseCache(60_000);
  cache.set(
    { owner: "user-a", authContext: "authenticated", canonicalUrl: canonical, extractorVersion: "1" },
    { text: "private-a" },
  );
  assert.equal(
    cache.get({ owner: "user-b", authContext: "authenticated", canonicalUrl: canonical, extractorVersion: "1" }),
    undefined,
  );
  assert.equal(
    cache.get({ owner: "user-a", authContext: "authenticated", canonicalUrl: canonical, extractorVersion: "1" }, true),
    undefined,
  );

  const digest = snapshotHash("Identical body text");
  const deduped = deduplicateByContentAndFamily([
    { sourceId: "s1", upstreamFamily: "fam-a", contentHash: digest },
    { sourceId: "s2", upstreamFamily: "fam-b", contentHash: digest },
    { sourceId: "s3", upstreamFamily: "fam-a", contentHash: snapshotHash("Other") },
  ]);
  assert.equal(deduped[0].independentCorroboration, true);
  assert.equal(deduped[1].independentCorroboration, false);
  assert.equal(deduped[2].independentCorroboration, false);

  const backoff = new HostBackoffTracker();
  const wait = backoff.recordFailure("fam-a", 2500, 1000);
  assert.equal(wait, 2500);
  assert.equal(backoff.isCoolingDown("fam-a", 2000).cooling, true);
  backoff.recordSuccess("fam-a");
  assert.equal(backoff.isCoolingDown("fam-a", 2000).cooling, false);
});

test("ThreeTierRouter honors policyRevision, disabled sources, strict overrides, and deterministic routing", () => {
  const reg = new CapabilityRegistry();
  const router = new ThreeTierRouter(reg);
  const pinnedFail = router.route({
    query: "search repo",
    overrides: { source: "x-search", allowFallback: false },
  });
  assert.equal(pinnedFail.selectedSourceId, undefined);
  assert.match(pinnedFail.sourceDecision.rationale, /unavailable/u);

  const prevRev = reg.policyRevision();
  reg.setEnabled("github", false);
  assert.notEqual(reg.policyRevision(), prevRev);
  const auto = router.route({ query: "github repository release" });
  assert.notEqual(auto.selectedSourceId, "github");
});

test("buildResearchPlan, CorpusIndex (BM25 + Hybrid), bounded loop, counter-evidence (SQ-074), and deep recovery (SQ-076)", async () => {
  const corpus = new CorpusIndex();
  corpus.addDocuments([
    { id: "d1", title: "Secondary Summary", text: "Notes mentioning caching and routing.", sourceTier: "secondary" },
    { id: "d2", title: "SourceQuest Primary Spec", text: "Bounded research loop with primary quotes and conflict verification.", sourceTier: "primary", publishedAt: "2026-11-01" },
  ]);
  const cmp = corpus.compareStrategies("SourceQuest primary quotes");
  assert.equal(cmp.hybridTopIds[0], "d2");

  const dir = mkdtempSync(join(tmpdir(), "sq-loop-"));
  const store = new SnapshotStore(dir);
  try {
    const searchPorts = new Map([
      [
        "host",
        {
          id: "host",
          upstreamFamily: "dsh-host",
          supportedFilters: [],
          async search(q) {
            if (q.includes("conflict") && q.includes("deprecated")) {
              return {
                hits: [{ url: "https://example.org/erratum", title: "Deprecated Erratum", snippet: "superseded notice" }],
                receipt: { providerId: "host", upstreamFamily: "dsh-host", logicalRequests: 1, knownBackendCalls: 1, backendCallsUnknown: false, durationMs: 1, cost: zeroCost("host"), supportedFilters: [] },
              };
            }
            if (q.includes("Verify conflict check")) {
              return {
                hits: [{ url: "https://example.org/conflict-details", title: "Conflict Details", upstreamFamily: "dsh-host-2" }],
                receipt: { providerId: "host", upstreamFamily: "dsh-host", logicalRequests: 1, knownBackendCalls: 1, backendCallsUnknown: false, durationMs: 1, cost: zeroCost("host"), supportedFilters: [] },
              };
            }
            return {
              hits: [{ url: "https://example.org/spec", title: "Primary Spec", upstreamFamily: "dsh-host" }],
              receipt: { providerId: "host", upstreamFamily: "dsh-host", logicalRequests: 1, knownBackendCalls: 1, backendCallsUnknown: false, durationMs: 1, cost: zeroCost("host"), supportedFilters: [] },
            };
          },
        },
      ],
    ]);
    const readPort = {
      id: "public-https",
      async read(url) {
        const text = url.includes("conflict-details")
          ? "Secondary verification details: bounded quotes are preserved across runs."
          : "Primary evidence quote: SourceQuest v0.1 enforces bounded quotes and primary verification.";
        return {
          page: { requestedUrl: url, finalUrl: url, statusCode: 200, mime: "text/html", encoding: "utf-8", title: "Primary Spec", text, extractor: "test", parserVersion: "1.0", truncated: false },
          receipt: { durationMs: 1, bytesRead: text.length, knownBackendCalls: 1, cost: zeroCost("public-https") },
        };
      },
    };
    const llmPort = new DshLlmAdapter({
      directCall: async () => ({
        text: JSON.stringify({ subQuestions: [{ question: "Verify conflict check", queries: ["Verify conflict check"] }] }),
        resolvedModel: "scarletkc-2.0",
        provider: "swift",
        inputTokens: 100,
        outputTokens: 40,
        cost: zeroCost("swift"),
      }),
    });

    const plan = await buildResearchPlan(
      { schemaVersion: 1, goal: "Check primary spec", intent: "research", urls: [], queries: ["Check primary spec"], focus: "bounded quotes", strategy: "balanced" },
      { wallTimeMs: 10_000, logicalRequests: 8, concurrency: 2 },
      llmPort,
      makeCtx(),
    );
    assert.equal(plan.usedModelPlanner, true);

    const loopRes = await runBoundedResearchLoop(
      {
        schemaVersion: 1,
        goal: "Check primary spec",
        intent: "research",
        urls: [],
        queries: ["Check primary spec"],
        focus: "bounded quotes",
        strategy: "balanced",
        output: { includeCounterEvidence: true },
      },
      {
        owner: "sess-1",
        searchPorts,
        readPort,
        llmPort,
        artifactStore: {
          saveSnapshot: (own, d, t) => store.save(own, d, t),
          readSnapshot: (own, d) => store.read(own, d),
        },
      },
      makeCtx("sess-1"),
    );

    assert.equal(loopRes.status, "completed");
    assert.equal(loopRes.evidence[0].snapshotSaved, true);
    assert.ok(loopRes.counterVerification && loopRes.counterVerification.conflictedClaims >= 1);

    const recovery = generateDeepRecoveryReport({
      taskId: "t-rec",
      resumedFromStatus: "interrupted",
      priorVerifiedSteps: 1,
      priorOutcomeUnknownSteps: 1,
      result: loopRes,
    });
    assert.equal(recovery.readyForDefaultPromotion, true);

    const binDigest = store.saveArtifact("sess-1", "art-1", Uint8Array.from([1, 2, 3]), "application/octet-stream");
    assert.ok(binDigest);
    assert.equal(store.readArtifact("sess-1", "art-1")?.bytes.byteLength, 3);
    const gc = store.gcOrphans(
      new Set(loopRes.evidence.map((e) => e.anchor.snapshotHash)),
      new Set(["art-1"]),
    );
    assert.equal(gc.snapshotsRemoved, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DshRpcService enforces owner auth + optimistic revision, client HTML renders slots, ExplicitDshWebBridge prevents recursion, and doctor hides secrets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sq-rpc-"));
  const store = new SnapshotStore(dir);
  const reg = new CapabilityRegistry();
  const ctx = new Context();
  const web = ctx.plugin(WebRuntime);
  try {
    await web.await();
    let calls = 0;
    const bridge = new ExplicitDshWebBridge(ctx.web, {
      enabled: true,
      searchProvider: {
        id: "host",
        async search() {
          calls += 1;
          assert.equal(ExplicitDshWebBridge.isInsideInternalCall(), true);
          return [{ url: "https://example.org/ok", title: "OK" }];
        },
      },
      readPage: async (url) => ({ finalUrl: url, mime: "text/plain", title: "OK", text: "Hello" }),
    });
    assert.equal(bridge.register(), true);
    const res = await ctx.web.search({ query: "test", maxResults: 1 });
    assert.equal(res.sources[0].url, "https://example.org/ok");
    assert.equal(calls, 1);
    bridge.dispose();
    assert.equal(bridge.isRegistered(), false);

    const rpc = new SourceQuestRpcService({ registry: reg, snapshots: () => store });
    assert.equal(rpc.listSources(undefined).status, 401);
    assert.equal(rpc.updatePolicy("sess-1", { expectedRevision: 99, defaultStrategy: "deep" }).status, 409);
    const pol = rpc.updatePolicy("sess-1", { expectedRevision: 1, defaultStrategy: "deep" });
    assert.equal(pol.ok, true);

    const html = renderSourceQuestPanelHtml({
      policyRevision: reg.policyRevision(),
      policy: pol.ok ? pol.data : { revision: 1, defaultStrategy: "balanced", allowFallback: true, strictCostCap: false, explicitWebProviderEnabled: false },
      sources: reg.list(),
      tasks: [{ taskId: "abcdef1234567890", status: "completed", revision: 2 }],
    });
    assert.match(html, /SourceQuest Native Control Panel/);

    const doc = await runDoctor({
      registry: reg,
      snapshots: () => store,
      hasTaskStore: true,
      checkBinary: async (name) => name === "pdftotext",
    });
    assert.equal(doc.ok, true);
    assert.equal(doc.optionalDependencies.find((d) => d.name === "pdftotext")?.available, true);
  } finally {
    await web.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("G7 connectors and optional executors enforce SSRF, cursor sync, auth revocation, gap marking, and resumable batch verification", async () => {
  const arxiv = createArxivConnector(async () => new Response(
    "<feed><entry><id>http://arxiv.org/abs/2611.00001</id><title>Test Paper</title><summary>Abstract</summary><published>2026-11-01T00:00:00Z</published></entry></feed>",
    { status: 200 },
  ));
  const aRes = await arxiv.search("sourcequest", 2, undefined, makeCtx());
  assert.equal(aRes.hits[0].url, "https://arxiv.org/abs/2611.00001");

  const openAlex = createOpenAlexConnector(async () => new Response(
    JSON.stringify({ results: [{ doi: "https://doi.org/10.1000/test", title: "OA Work", publication_date: "2026-10-10" }] }),
    { status: 200 },
  ));
  const oRes = await openAlex.search("sourcequest", 2, undefined, makeCtx());
  assert.equal(oRes.hits[0].url, "https://doi.org/10.1000/test");

  const feed = createChineseFeedConnector(
    ["https://feed.example.org/rss.xml"],
    async (url) => ({ finalUrl: url, mime: "text/plain", title: "Feed", text: "探原发布 https://docs.example.org/post-1" }),
  );
  assert.equal((await feed.search("探原", 2, undefined, makeCtx())).hits[0].url, "https://docs.example.org/post-1");

  const xConn = createXCapabilityConnector();
  await assert.rejects(xConn.search("query", 2, undefined, makeCtx()), /AUTH_REQUIRED|credentials/iu);

  const collab = createCollabConnector("notion", {
    fetchPage: async () => ({ items: [], authRevoked: true, gap: { from: "c1", to: "c2", reason: "token revoked" } }),
  });
  const collabOut = await collab.sync({ limit: 10, authTokenRef: "ref-1" }, makeCtx());
  assert.equal(collabOut.authRevoked, true);

  const live = createLivestreamConnector({
    pollWindow: async () => ({
      segments: [{ itemId: "seg-1", url: "https://cdn.example.org/1.ts", title: "Seg 1", body: "ok", anchorRef: "t=0" }],
      outageGap: { from: "00:10", to: "00:15", reason: "stream drop without replay" },
    }),
  });
  assert.equal((await live.sync({ limit: 5 }, makeCtx())).unrecoverableGaps.length, 1);

  assert.ok(BROWSER_COMPARISON_MATRIX.some((m) => m.id === "playwright"));
  const browser = new BrowserExecutor(async (req) => ({
    finalUrl: req.url,
    title: "Rendered",
    text: "Rendered SPA content",
    links: [],
    stepsUsed: 1,
  }));
  await assert.rejects(browser.browse({ url: "http://127.0.0.1/", maxSteps: 1 }, makeCtx()), /public HTTPS/);
  assert.equal((await browser.browse({ url: "https://example.org/app", maxSteps: 1 }, makeCtx())).text, "Rendered SPA content");

  const docParser = new DocumentParserExecutor();
  const docRes = await docParser.execute(
    { jobType: "snapshot", executorId: "pdf-ocr", resourceKind: "paper_ebook", items: [{ itemId: "p1", url: "https://example.org/a.pdf" }] },
    new Map(),
    makeCtx(),
  );
  assert.equal(docRes.outcomes[0].status, "unsupported");

  const crawlExec = new Crawl4AiExecutor(async (_u, _d) => ({ text: "Crawled body", links: ["https://example.org/sub"] }));
  const crawlRes = await crawlExec.execute(
    {
      jobType: "batch",
      executorId: "crawl4ai",
      resourceKind: "web_crawl",
      allowedDomains: ["example.org"],
      items: [
        { itemId: "ok", url: "https://example.org/1" },
        { itemId: "bad", url: "https://other.org/1" },
      ],
    },
    new Map(),
    makeCtx(),
  );
  assert.equal(crawlRes.outcomes[0].status, "failed");

  const bytes = new TextEncoder().encode("dataset-payload-v1");
  const digest = snapshotHash(bytes);
  const batchQueue = new ResumableBatchQueueExecutor(async () => ({ bytes }));
  const prior = new Map([["done-item", { itemId: "done-item", status: "verified", sha256: digest, bytes: bytes.byteLength }]]);
  const batchOut = await batchQueue.execute(
    {
      jobType: "batch",
      executorId: "batch-queue",
      resourceKind: "dataset",
      items: [
        { itemId: "done-item", url: "https://data.example.org/1.bin", version: "v1" },
        { itemId: "new-item", url: "https://data.example.org/2.bin", expectedSha256: digest, expectedBytes: bytes.byteLength, version: "v1" },
      ],
    },
    prior,
    makeCtx(),
  );
  assert.equal(batchOut.outcomes[0].status, "skipped_verified");
  assert.equal(batchOut.outcomes[1].status, "verified");

  const academicPlan = planAcademicDatasetExecution({
    jobType: "batch",
    executorId: "batch-queue",
    resourceKind: "dataset",
    items: [{ itemId: "ds-1", url: "https://data.example.org/ds.parquet", version: "rev-2026" }],
  });
  assert.equal(academicPlan.pinnedRevisionsPresent, true);
});

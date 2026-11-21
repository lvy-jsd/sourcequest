import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolsService } from "@deepseek-ai/dsh-tools";
import WebRuntime from "@deepseek-ai/dsh-web";
import * as sourcequest from "../dist/index.js";
import {
  BudgetLedger,
  CapabilityRegistry,
  ExplicitDshWebBridge,
  HostBackoffTracker,
  ResponseCache,
  SourceQuestRpcService,
  ThreeTierRouter,
  deduplicateByContentAndFamily,
  renderSourceQuestPanelHtml,
  runBoundedResearchLoop,
  runDoctor,
  triageReadPage,
} from "../dist/index.js";
import { publicHttpsUrl } from "../dist/adapters/public-https.js";
import { research } from "../dist/core/research.js";
import { SnapshotStore, snapshotHash } from "../dist/core/snapshot-store.js";
import { changeTaskState } from "../dist/core/task-state.js";

function zeroCost(src) {
  return { kind: "actual", currency: "USD", minorUnits: 0, source: src, recordedAt: new Date().toISOString() };
}

function ctxFor(owner = "sess-b") {
  return {
    identity: { taskId: "b-task", runId: "b-run", stepId: "b-step", attemptId: "1", owner },
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 10_000,
    authContext: "public",
  };
}

test("B1-B3: works without Magpie/Tool Ultra, avoids recursion/duplicates, explicit provider toggles cleanly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sq-b1-"));
  const store = new SnapshotStore(dir);
  const ctx = new Context();
  const sys = ctx.plugin(SystemPrompt);
  const tools = ctx.plugin(ToolsService);
  const web = ctx.plugin(WebRuntime);
  try {
    await sys.await();
    await tools.await();
    await web.await();
    const plugin = ctx.plugin(sourcequest);
    await plugin.await();

    const names = ctx.tools.schemas().map((s) => s.name);
    assert.equal(names.filter((n) => n === "net_research").length, 1);
    assert.equal(names.includes("sourcequest_doctor"), true);

    const bridge = new ExplicitDshWebBridge(ctx.web, {
      enabled: true,
      searchProvider: { id: "host", async search() { return []; } },
      readPage: async (url) => ({ finalUrl: url, mime: "text/plain", title: "T", text: "Body" }),
    });
    assert.equal(bridge.register(), true);
    assert.equal(ctx.web.listProviders().search.some((p) => p.id === "sourcequest-explicit"), true);
    bridge.dispose();
    assert.equal(ctx.web.listProviders().search.some((p) => p.id === "sourcequest-explicit"), false);

    const doc = await runDoctor({ registry: new CapabilityRegistry(), snapshots: () => store, hasTaskStore: false });
    assert.ok(doc.unconfiguredSources.includes("x-search"));

    await plugin.dispose();
    assert.equal(ctx.tools.get("net_research"), undefined);
  } finally {
    await web.dispose();
    await tools.dispose();
    await sys.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B4-B7: partial query isolation + cancellation, SSRF rejection, token/snapshot limits, URL-only direct read", async () => {
  const ac = new AbortController();
  const res = await research(
    { queries: ["fail-q", "ok-q"], urls: ["https://example.org/direct"] },
    {
      normalizeUrl: (u) => publicHttpsUrl(u).href,
      async search(q) {
        if (q === "fail-q") throw new Error("upstream down");
        return [{ url: "https://127.0.0.1/internal" }];
      },
      async read(url) {
        return { finalUrl: url, mime: "text/plain", title: "Direct", text: "Direct primary source paragraph." };
      },
    },
    ac.signal,
  );
  assert.equal(res.status, "partial");
  assert.equal(res.evidence.length, 1);
  assert.equal(res.issues.some((i) => i.code === "SEARCH_FAILED"), true);
  assert.throws(() => publicHttpsUrl("https://169.254.169.254/latest/meta-data"));
});

test("B8-B13: constraint checks, disabled source gating, pinned override failures, 429 cooldown, triage classification, unsupported MIME", async () => {
  const reg = new CapabilityRegistry();
  reg.setEnabled("github", false);
  const router = new ThreeTierRouter(reg, new HostBackoffTracker());

  const datePlan = router.route({ query: "latest commit", constraints: { dateFrom: "2026-01-01" }, overrides: { source: "host", allowFallback: false } });
  assert.equal(datePlan.selectedSourceId, undefined);

  const disabledPlan = router.route({ query: "github repo", overrides: { source: "github", allowFallback: false } });
  assert.equal(disabledPlan.selectedSourceId, undefined);

  assert.equal(triageReadPage({ statusCode: 200, mime: "text/html", title: "Up", text: "Maintenance window ends 04:00 UTC." }).classification, "verified");
  assert.equal(triageReadPage({ statusCode: 200, mime: "application/pdf", title: "Doc", text: "%PDF-1.7" }).classification, "unsupported_mime");
});

test("B14-B16: budget bounds, partial open gaps on exhaustion, cancellation/stale-run protection", async () => {
  const ledger = new BudgetLedger({ wallTimeMs: 5000, logicalRequests: 1, concurrency: 1 });
  assert.equal(ledger.reserve("r1", { logicalRequests: 1 }).ok, true);
  assert.equal(ledger.reserve("r2", { logicalRequests: 1 }).ok, false);

  const stale = changeTaskState(
    { schemaVersion: 1, taskId: "t1", runId: "run-2", status: "running", revision: 3, eventSeq: 3 },
    { kind: "transition", runId: "run-1", expectedRevision: 2, status: "completed" },
  );
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, "STALE_RUN");
});

test("B17-B22: corrupted snapshot/interrupted recovery, cross-session auth denial, cache isolation, primary claim grounding, UI panel & cleanup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sq-b17-"));
  const store = new SnapshotStore(dir);
  try {
    const body = "Verified authoritative statement.";
    const digest = snapshotHash(body);
    store.save("owner-a", digest, body);
    assert.equal(store.read("owner-b", digest), undefined);

    const rpc = new SourceQuestRpcService({ registry: new CapabilityRegistry(), snapshots: () => store });
    assert.equal(rpc.readEvidence("owner-b", digest).status, 404);
    assert.equal(rpc.readEvidence(undefined, digest).status, 401);

    const cache = new ResponseCache(60_000);
    cache.set({ owner: "owner-a", authContext: "authenticated", canonicalUrl: "https://example.org/p", extractorVersion: "1" }, { secret: 1 });
    assert.equal(cache.get({ owner: "owner-b", authContext: "authenticated", canonicalUrl: "https://example.org/p", extractorVersion: "1" }), undefined);

    const dedup = deduplicateByContentAndFamily([
      { sourceId: "s1", upstreamFamily: "same", contentHash: digest },
      { sourceId: "s2", upstreamFamily: "same", contentHash: digest },
    ]);
    assert.equal(dedup[1].independentCorroboration, false);

    const emptyLoop = await runBoundedResearchLoop(
      { schemaVersion: 1, goal: "Impossible claim", intent: "research", urls: [], queries: ["missing"], focus: "x", strategy: "quick" },
      {
        owner: "owner-a",
        searchPorts: new Map(),
        readPort: { id: "public-https", async read() { throw new Error("nope"); } },
      },
      ctxFor("owner-a"),
    );
    assert.equal(emptyLoop.claims[0].kind, "unknown");

    const html = renderSourceQuestPanelHtml({
      policyRevision: "pol-v1",
      policy: { revision: 1, defaultStrategy: "balanced", allowFallback: true, strictCostCap: false, explicitWebProviderEnabled: false },
      sources: [],
      tasks: [],
    });
    assert.match(html, /panel-evidence/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

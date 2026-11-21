import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Context } from "@deepseek-ai/cordis";
import { createScope } from "@deepseek-ai/dsh-scope";
import Storage from "@deepseek-ai/dsh-storage";
import * as storageDomain from "@deepseek-ai/dsh-storage-domain";
import * as storageJson from "@deepseek-ai/dsh-storage-json";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolsService } from "@deepseek-ai/dsh-tools";
import WebRuntime, { WebError } from "@deepseek-ai/dsh-web";
import { DshTaskStore } from "../dist/adapters/dsh-task-store.js";
import * as sourcequest from "../dist/index.js";

async function withMountedSourcequest(fetchImpl, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const ctx = new Context();
  const systemPrompt = ctx.plugin(SystemPrompt);
  const tools = ctx.plugin(ToolsService);
  const web = ctx.plugin(WebRuntime);
  let scope;
  let plugin;
  try {
    await Promise.all([systemPrompt.await(), tools.await(), web.await()]);
    const scopeKey = {};
    scope = createScope(ctx, scopeKey);
    plugin = scope.ctx.plugin(sourcequest);
    await plugin.await();
    for (let attempt = 0; attempt < 40 && !ctx.tools.executable("net_research", scopeKey); attempt++) {
      await delay(10);
    }
    const netResearch = ctx.tools.executable("net_research", scopeKey);
    assert.ok(netResearch, "net_research tool should be registered");
    return await run({ ctx, scopeKey, netResearch });
  } finally {
    globalThis.fetch = originalFetch;
    await plugin?.dispose();
    await scope?.dispose();
    await web.dispose();
    await tools.dispose();
    await systemPrompt.dispose();
  }
}

function fakeAgent(provider) {
  return {
    session: {
      requestContext: () => ({ provider }),
    },
  };
}

test("net_research tool exposes source and allowFallback parameters and maps sanitized WebErrors", async () => {
  const scenario = { mode: "ready-false" };
  let fetchCalls = 0;

  await withMountedSourcequest(async (url) => {
    fetchCalls++;
    const href = String(url);
    if (href.startsWith("https://api.github.com/search/repositories")) {
      return Response.json({ items: [] });
    }
    if (href.startsWith("https://api.crossref.org/works")) {
      return Response.json({ message: { items: [] } });
    }
    assert.fail(`Unexpected fetch URL: ${href}`);
  }, async ({ ctx, netResearch }) => {
    assert.deepEqual(netResearch.parameters.properties.source.enum, ["auto", "host", "github", "crossref"]);
    assert.equal(netResearch.parameters.properties.allowFallback.type, "boolean");

    ctx.web.registerSearchProvider({
      id: "mock-host",
      available: () => true,
      async ready() {
        return scenario.mode !== "ready-false";
      },
      async search() {
        switch (scenario.mode) {
          case "cred-missing":
            throw new WebError("secret-token-missing at https://internal.example", "WEB_PROVIDER_CREDENTIAL_MISSING");
          case "unavailable":
            throw new WebError("secret-host-down", "WEB_PROVIDER_UNAVAILABLE");
          case "http-429":
            throw new WebError("DeepSeek API error (HTTP 429): secret-rate-body", "WEB_PROVIDER_ERROR");
          case "timeout":
            throw new WebError("secret-upstream-timeout", "WEB_TIMEOUT");
          case "generic-fail":
            throw new WebError("secret endpoint https://private.invalid/key=123", "WEB_PROVIDER_ERROR");
          case "empty":
            return { sources: [], truncated: false };
          default:
            return { sources: [{ url: "https://127.0.0.1/blocked" }], truncated: false };
        }
      },
    });

    const exec = (args) => netResearch.execute(args, { signal: new AbortController().signal });

    // 1) searchReady() === false -> AUTH_REQUIRED when host is pinned
    const readyFalse = await exec({ queries: ["q"], source: "host" });
    assert.deepEqual(readyFalse.issues.map((i) => i.code), ["AUTH_REQUIRED"]);
    assert.equal(fetchCalls, 0);

    // 2) searchReady() === false with source: "auto" falls back to github & crossref; preserves AUTH_REQUIRED instead of EMPTY_RESULT
    const autoFallback = await exec({ queries: ["q"], source: "auto" });
    assert.equal(fetchCalls, 2);
    assert.deepEqual(autoFallback.issues.map((i) => i.code), ["AUTH_REQUIRED"]);

    // 3) WEB_PROVIDER_CREDENTIAL_MISSING -> AUTH_REQUIRED, no leak
    scenario.mode = "cred-missing";
    const credMissing = await exec({ queries: ["q"], source: "host" });
    assert.deepEqual(credMissing.issues.map((i) => i.code), ["AUTH_REQUIRED"]);
    assert.equal(JSON.stringify(credMissing).includes("secret-token-missing"), false);

    // 4) WEB_PROVIDER_UNAVAILABLE -> SEARCH_FAILED, no leak
    scenario.mode = "unavailable";
    const unavailable = await exec({ queries: ["q"], source: "host" });
    assert.deepEqual(unavailable.issues.map((i) => i.code), ["SEARCH_FAILED"]);
    assert.equal(JSON.stringify(unavailable).includes("secret-host-down"), false);

    // 5) WEB_TIMEOUT -> TIMEOUT, no leak
    scenario.mode = "timeout";
    const timedOut = await exec({ queries: ["q"], source: "host" });
    assert.deepEqual(timedOut.issues.map((i) => i.code), ["TIMEOUT"]);
    assert.equal(JSON.stringify(timedOut).includes("secret-upstream-timeout"), false);

    // 6) Generic WEB_PROVIDER_ERROR -> SEARCH_FAILED, no leak
    scenario.mode = "generic-fail";
    const failed = await exec({ queries: ["q"], source: "host" });
    assert.deepEqual(failed.issues.map((i) => i.code), ["SEARCH_FAILED"]);
    assert.equal(JSON.stringify(failed).includes("private.invalid"), false);

    // 7) Empty sources -> EMPTY_RESULT
    scenario.mode = "empty";
    const empty = await exec({ queries: ["q"], source: "host" });
    assert.deepEqual(empty.issues.map((i) => i.code), ["EMPTY_RESULT"]);

    // 8) WEB_PROVIDER_ERROR with HTTP 429 -> RATE_LIMITED, no leak, and puts host on cooldown
    scenario.mode = "http-429";
    const rateLimited = await exec({ queries: ["q"], source: "host" });
    assert.deepEqual(rateLimited.issues.map((i) => i.code), ["RATE_LIMITED"]);
    assert.equal(JSON.stringify(rateLimited).includes("secret-rate-body"), false);

    // Host is now cooling down on the shared SearchRouter: even if provider switches to empty, it stays RATE_LIMITED without calling provider
    scenario.mode = "empty";
    const coolingDown = await exec({ queries: ["q"], source: "host" });
    assert.deepEqual(coolingDown.issues.map((i) => i.code), ["RATE_LIMITED"]);
  });
});

test("AsyncLocalStorage isolates concurrent llmProvider values per net_research call", async () => {
  const seen = [];
  await withMountedSourcequest(async () => new Response(null, { status: 500 }), async ({ ctx, netResearch }) => {
    ctx.web.registerSearchProvider({
      id: "als-test",
      available: () => true,
      async ready(llmProvider) {
        await delay(llmProvider === "route-alpha" ? 25 : 5);
        seen.push({ phase: "ready", llmProvider });
        return true;
      },
      async search(request) {
        await delay(request.llmProvider === "route-alpha" ? 20 : 5);
        seen.push({ phase: "search", llmProvider: request.llmProvider, query: request.query });
        return { sources: [], truncated: false };
      },
    });

    const [resA, resB] = await Promise.all([
      netResearch.execute(
        { queries: ["alpha-query"], source: "host" },
        { signal: new AbortController().signal, agent: fakeAgent("route-alpha") },
      ),
      netResearch.execute(
        { queries: ["beta-query"], source: "host" },
        { signal: new AbortController().signal, agent: fakeAgent("route-beta") },
      ),
    ]);

    assert.deepEqual(resA.issues.map((i) => i.code), ["EMPTY_RESULT"]);
    assert.deepEqual(resB.issues.map((i) => i.code), ["EMPTY_RESULT"]);
    assert.deepEqual(
      seen.filter((entry) => entry.phase === "ready").map((entry) => entry.llmProvider).sort(),
      ["route-alpha", "route-beta"],
    );
    assert.deepEqual(
      seen.filter((entry) => entry.phase === "search").sort((a, b) => a.query.localeCompare(b.query)),
      [
        { phase: "search", llmProvider: "route-alpha", query: "alpha-query" },
        { phase: "search", llmProvider: "route-beta", query: "beta-query" },
      ],
    );
  });
});

test("lifecycle-scoped SearchRouter persists public provider cooldowns and serializes calls across net_research invocations", async () => {
  let fetchCalls = 0;
  let inFlight = 0;
  let maxInFlight = 0;

  await withMountedSourcequest(async () => {
    fetchCalls++;
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await delay(20);
      return new Response(null, { status: 429, headers: { "retry-after": "60" } });
    } finally {
      inFlight--;
    }
  }, async ({ netResearch }) => {
    const [first, second] = await Promise.all([
      netResearch.execute({ queries: ["repo one"], source: "github" }, { signal: new AbortController().signal }),
      netResearch.execute({ queries: ["repo two"], source: "github" }, { signal: new AbortController().signal }),
    ]);
    assert.deepEqual(first.issues.map((i) => i.code), ["RATE_LIMITED"]);
    assert.deepEqual(second.issues.map((i) => i.code), ["RATE_LIMITED"]);
    assert.equal(maxInFlight, 1);
    assert.equal(fetchCalls, 1);

    const third = await netResearch.execute(
      { queries: ["repo three"], source: "github" },
      { signal: new AbortController().signal },
    );
    assert.deepEqual(third.issues.map((i) => i.code), ["RATE_LIMITED"]);
    assert.equal(fetchCalls, 1);
  });
});

test("DshTaskStore preserves legacy idempotency while persisting optional source and allowFallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "sourcequest-m1-store-"));
  const ctx = new Context();
  const storage = ctx.plugin(Storage);
  const backend = ctx.plugin(storageJson, { root });
  const domain = ctx.plugin(storageDomain, { backend: "json" });
  let store;
  try {
    await Promise.all([storage.await(), backend.await(), domain.await()]);
    store = await DshTaskStore.open(ctx.storageDomain);

    const legacy = { queries: ["fixture"], urls: [], focus: "" };
    const first = await store.create("session-1", "legacy-key", legacy);
    const repeat = await store.create("session-1", "legacy-key", legacy);
    assert.equal(first.created, true);
    assert.equal(repeat.created, false);
    await assert.rejects(
      store.create("session-1", "legacy-key", { ...legacy, source: "github" }),
      { code: "CONFLICT" },
    );

    const routed = { queries: ["paper DOI"], urls: [], focus: "", source: "crossref", allowFallback: false };
    const createdRouted = await store.create("session-1", "routed-key", routed);
    assert.equal(createdRouted.created, true);
    await store.close();
    store = undefined;

    store = await DshTaskStore.open(ctx.storageDomain);
    const loaded = store.get("session-1", createdRouted.run.state.taskId);
    assert.deepEqual(loaded.request, routed);
  } finally {
    await store?.close();
    await domain.dispose();
    await backend.dispose();
    await storage.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("createHostSearch maps WebError and propagates caller aborts thrown from web.searchReady()", async () => {
  const scenario = { mode: "cred-missing", onReady: undefined };
  let searchCalls = 0;
  let fetchCalls = 0;

  await withMountedSourcequest(async (url) => {
    fetchCalls++;
    const href = String(url);
    if (href.startsWith("https://api.github.com/search/repositories")) {
      return Response.json({ items: [] });
    }
    if (href.startsWith("https://api.crossref.org/works")) {
      return Response.json({ message: { items: [] } });
    }
    assert.fail(`Unexpected fetch URL: ${href}`);
  }, async ({ ctx, netResearch }) => {
    ctx.web.registerSearchProvider({
      id: "ready-throw-host",
      available: () => true,
      async ready() {
        switch (scenario.mode) {
          case "cred-missing":
            throw new WebError("secret-ready-cred at https://internal.invalid", "WEB_PROVIDER_CREDENTIAL_MISSING");
          case "configured-missing":
            throw new WebError("secret-ready-missing-id", "WEB_PROVIDER_CONFIGURED_MISSING");
          case "aborted":
            throw new WebError("secret-ready-aborted", "WEB_ABORTED");
          case "caller-aborted":
            scenario.onReady?.();
            throw new WebError("secret-caller-abort", "WEB_ABORTED");
          default:
            return true;
        }
      },
      async search() {
        searchCalls++;
        return { sources: [], truncated: false };
      },
    });

    const exec = (args, signal = new AbortController().signal) => netResearch.execute(args, { signal });

    // 1) ready() throws WEB_PROVIDER_CREDENTIAL_MISSING -> mapped to AUTH_REQUIRED, no leak
    scenario.mode = "cred-missing";
    const credMissing = await exec({ queries: ["q"], source: "host" });
    assert.deepEqual(credMissing.issues.map((i) => i.code), ["AUTH_REQUIRED"]);
    assert.equal(JSON.stringify(credMissing).includes("secret-ready-cred"), false);
    assert.equal(searchCalls, 0);

    // 2) ready() throws WEB_PROVIDER_CONFIGURED_MISSING -> pinned SEARCH_FAILED, auto falls back to public providers
    scenario.mode = "configured-missing";
    const missingPinned = await exec({ queries: ["q"], source: "host" });
    assert.deepEqual(missingPinned.issues.map((i) => i.code), ["SEARCH_FAILED"]);
    assert.equal(JSON.stringify(missingPinned).includes("secret-ready-missing-id"), false);

    const missingAuto = await exec({ queries: ["q"], source: "auto" });
    assert.equal(fetchCalls, 2);
    assert.deepEqual(missingAuto.issues.map((i) => i.code), ["SEARCH_FAILED"]);
    assert.equal(JSON.stringify(missingAuto).includes("secret-ready-missing-id"), false);

    // 3) ready() throws WEB_ABORTED without caller abort -> sanitized SEARCH_FAILED
    scenario.mode = "aborted";
    const providerAborted = await exec({ queries: ["q"], source: "host" });
    assert.deepEqual(providerAborted.issues.map((i) => i.code), ["SEARCH_FAILED"]);
    assert.equal(JSON.stringify(providerAborted).includes("secret-ready-aborted"), false);

    // 4) ready() throws WEB_ABORTED when caller signal is aborted -> propagates caller abort reason
    scenario.mode = "caller-aborted";
    const controller = new AbortController();
    const callerReason = new Error("caller aborted during searchReady");
    scenario.onReady = () => controller.abort(callerReason);
    await assert.rejects(exec({ queries: ["q"], source: "host" }, controller.signal), (err) => err === callerReason);
    assert.equal(searchCalls, 0);
  });
});

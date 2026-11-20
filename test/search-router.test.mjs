import assert from "node:assert/strict";
import { test } from "node:test";
import { SearchProviderError, SearchRouter } from "../dist/core/search-router.js";

const signal = () => new AbortController().signal;
const hit = (id) => ({ url: `https://example.org/${id}` });
const success = (id, calls) => ({
  id,
  async search(query, maxResults) {
    calls.push({ id, query, maxResults });
    return [hit(id)];
  },
});

test("automatic routing favors the built-in search or an explicit vertical topic", async () => {
  const calls = [];
  const router = new SearchRouter(["crossref", "github", "host"].map((id) => success(id, calls)));

  for (const [query, source] of [
    ["weather in Perth", "host"],
    ["GitHub repository for DSH", "github"],
    ["某篇学术论文的 DOI", "crossref"],
  ]) {
    const result = await router.search(query, 2, signal());
    assert.deepEqual(result, {
      hits: [hit(source)],
      attempts: [{ source, status: "ok", dispatched: true }],
    });
    assert.deepEqual(calls.pop(), { id: source, query, maxResults: 2 });
  }
});

test("a pinned source requires explicit fallback and an unconfigured source is never invoked", async () => {
  const calls = [];
  const router = new SearchRouter([success("host", calls)]);
  const query = "DSH";

  assert.deepEqual(await router.search(query, 1, signal(), { source: "github" }), {
    hits: [],
    attempts: [{ source: "github", status: "unavailable", dispatched: false }],
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(await router.search(query, 1, signal(), { source: "github", allowFallback: true }), {
    hits: [hit("host")],
    attempts: [
      { source: "github", status: "unavailable", dispatched: false },
      { source: "host", status: "ok", dispatched: true },
    ],
  });
  assert.equal(calls.length, 1);

  const failingPrimary = new SearchRouter([
    { id: "github", async search() { throw new Error("Synthetic failure"); } },
    success("host", calls),
  ]);
  const disabled = await failingPrimary.search("GitHub repository", 2, signal(), { allowFallback: false });
  assert.deepEqual(disabled, { hits: [], attempts: [{ source: "github", status: "failed", dispatched: true }] });
  assert.equal(calls.length, 1);
});

test("fallback retains only the first usable source and respects the hit limit", async () => {
  const calls = [];
  const router = new SearchRouter([
    {
      id: "github",
      async search() {
        return [{ url: "http://example.org/" }, { url: "https://credential@example.org/" }];
      },
    },
    {
      id: "host",
      async search() {
        return [
          hit("version?v=1#title"),
          hit("version?v=1#page"),
          hit("version?v=2"),
          hit("outside-limit"),
        ];
      },
    },
    success("crossref", calls),
  ]);

  const result = await router.search("GitHub repository", 2, signal());
  assert.deepEqual(result, {
    hits: [hit("version?v=1"), hit("version?v=2")],
    attempts: [
      { source: "github", status: "empty", dispatched: true },
      { source: "host", status: "ok", dispatched: true },
    ],
  });
  assert.deepEqual(calls, []);
});

test("rate limits cool down only their source and preserve long server retry hints", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const calls = [];
  let githubCalls = 0;
  const router = new SearchRouter([
    success("host", calls),
    {
      id: "github",
      async search() {
        githubCalls++;
        if (githubCalls === 1) throw new SearchProviderError("rate_limited", "sensitive API message", 300_000);
        return [hit("github")];
      },
    },
  ]);

  const first = await router.search("GitHub repository", 1, signal());
  assert.deepEqual(first.attempts[0], {
    source: "github", status: "rate_limited", dispatched: true, retryAfterMs: 300_000,
  });
  assert.equal(JSON.stringify(first).includes("sensitive API message"), false);
  assert.deepEqual(first.hits, [hit("host")]);

  t.mock.timers.setTime(201_000);
  const second = await router.search("GitHub repository", 1, signal());
  assert.deepEqual(second.attempts[0], {
    source: "github", status: "cooldown", dispatched: false, retryAfterMs: 100_000,
  });
  assert.deepEqual(second.hits, [hit("host")]);
  assert.equal(githubCalls, 1);

  t.mock.timers.setTime(301_000);
  const third = await router.search("GitHub repository", 1, signal());
  assert.deepEqual(third.hits, [hit("github")]);
  assert.equal(githubCalls, 2);
  assert.equal(calls.length, 2);
});

test("a hung adapter times out before using an available fallback", async () => {
  const calls = [];
  let upstreamSignal;
  const router = new SearchRouter([
    {
      id: "host",
      search(_query, _limit, signal) {
        upstreamSignal = signal;
        return new Promise(() => {});
      },
    },
    success("github", calls),
  ]);

  const result = await router.search("DSH", 1, signal());
  assert.equal(upstreamSignal.aborted, true);
  assert.deepEqual(result, {
    hits: [hit("github")],
    attempts: [
      { source: "host", status: "timeout", dispatched: true },
      { source: "github", status: "ok", dispatched: true },
    ],
  });
});

test("caller cancellation propagates immediately and does not trigger fallback", async () => {
  const calls = [];
  const controller = new AbortController();
  const reason = new Error("cancel from caller");
  const router = new SearchRouter([
    {
      id: "host",
      search(_query, _limit, signal) {
        assert.equal(signal.aborted, false);
        controller.abort(reason);
        assert.equal(signal.aborted, true);
        return new Promise(() => {});
      },
    },
    success("github", calls),
  ]);
  await assert.rejects(router.search("DSH", 1, controller.signal), (error) => error === reason);
  assert.deepEqual(calls, []);
});

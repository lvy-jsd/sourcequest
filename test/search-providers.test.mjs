import assert from "node:assert/strict";
import { test } from "node:test";
import { createCrossrefSearch, createGithubSearch } from "../dist/adapters/search-providers.js";
import { SearchProviderError } from "../dist/core/search-router.js";

const signal = () => new AbortController().signal;

test("GitHub repository search uses bounded anonymous requests and accepts only public repository URLs", async () => {
  const query = "索引 & repo:torvalds/linux";
  const abort = signal();
  const repo = createGithubSearch(async (url, options) => {
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(url.pathname, "/search/repositories");
    assert.equal(url.searchParams.get("q"), query);
    assert.equal(url.searchParams.get("per_page"), "10");
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.equal(options.signal, abort);
    const headers = new Headers(options.headers);
    assert.equal(headers.get("x-github-api-version"), "2026-03-10");
    assert.equal(headers.has("authorization"), false);
    assert.equal(headers.has("cookie"), false);

    return Response.json({
      items: [
        { html_url: "https://github.com/a/b", full_name: "a/b", description: " a\npublic repo " },
        { html_url: "https://github.com/private/repo", private: true },
        { html_url: "https://github.com/owner/." },
        { html_url: "https://github.com.evil.example/x/y" },
        { html_url: "https://github.com/a/b?secret=secret" },
        ...Array.from({ length: 7 }, (_, index) => ({ html_url: `https://github.com/c/repo-${index}` })),
      ],
    });
  });
  assert.deepEqual(await repo.search(query, 80, abort), [
    { url: "https://github.com/a/b", title: "a/b", snippet: "a public repo" },
    ...Array.from({ length: 5 }, (_, index) => ({ url: `https://github.com/c/repo-${index}`, title: `c/repo-${index}` })),
  ]);
});

test("Crossref requests selected bibliographic fields and constructs safe DOI links", async () => {
  const query = "A mathematical theory of communication";
  const works = createCrossrefSearch(async (url, options) => {
    assert.equal(url.origin, "https://api.crossref.org");
    assert.equal(url.pathname, "/works");
    assert.equal(url.searchParams.get("query.bibliographic"), query);
    assert.equal(url.searchParams.get("rows"), "3");
    assert.equal(url.searchParams.get("select"), "DOI,title,container-title,publisher");
    assert.equal(url.searchParams.has("mailto"), false);
    assert.equal(new Headers(options.headers).has("crossref-api-key"), false);
    return Response.json({ message: { items: [
      { DOI: "10.1000/example?#", title: ["Work"], "container-title": [" Journal "], publisher: "Publisher", URL: "http://malformed.example/" },
      { DOI: "10.1000/../bypass" },
      { DOI: "10.5555/some/compound", title: [], publisher: "Journal" },
    ] } });
  });
  assert.deepEqual(await works.search(query, 3, signal()), [
    { url: "https://doi.org/10.1000/example%3F%23", title: "Work", snippet: "Journal · Publisher" },
    { url: "https://doi.org/10.5555/some/compound", snippet: "Journal" },
  ]);
});

test("GitHub recognizes 403 quotas without leaking upstream bodies and suppresses queued requests", async () => {
  let calls = 0;
  const github = createGithubSearch(async () => {
    calls++;
    return Response.json({ message: "secondary rate limit: upstream secret" }, { status: 403 });
  });
  const [one, two] = await Promise.allSettled([github.search("first", 1, signal()), github.search("second", 1, signal())]);
  for (const outcome of [one, two]) {
    assert.equal(outcome.status, "rejected");
    assert.ok(outcome.reason instanceof SearchProviderError);
    assert.equal(outcome.reason.code, "rate_limited");
    assert.ok(outcome.reason.retryAfterMs > 59_000);
    assert.doesNotMatch(outcome.reason.message, /upstream secret/u);
  }
  assert.equal(calls, 1);
});

test("retry delay honors Crossref Retry-After and GitHub reset timestamps", async () => {
  const crossref = createCrossrefSearch(async () => new Response(null, {
    status: 429,
    headers: { "retry-after": "7" },
  }));
  await assert.rejects(crossref.search("x", 1, signal()), { code: "rate_limited", retryAfterMs: 7000 });

  const reset = Math.ceil(Date.now() / 1000) + 120;
  const github = createGithubSearch(async () => new Response(null, {
    status: 403,
    headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset), "retry-after": "1" },
  }));
  await assert.rejects(github.search("x", 1, signal()), (error) => {
    assert.equal(error.code, "rate_limited");
    assert.ok(error.retryAfterMs >= 118_000 && error.retryAfterMs <= 121_000);
    return true;
  });
});

test("Crossref queue honors cancellation and avoids concurrent requests", async () => {
  const controller = new AbortController();
  let calls = 0;
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const crossref = createCrossrefSearch(async () => {
    calls++;
    if (calls === 1) await blocked;
    return Response.json({ message: { items: [] } });
  });
  const first = crossref.search("first", 1, signal());
  const queued = crossref.search("cancel", 1, controller.signal);
  const last = crossref.search("last", 1, signal());
  controller.abort(new Error("cancel while queued"));
  await assert.rejects(queued, /cancel while queued/u);
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await first, []);
  assert.deepEqual(await last, []);
  assert.equal(calls, 2);
});

test("malformed, oversized, denied and timed-out API responses return sanitized errors", async () => {
  for (const [endpoint, response, code] of [
    [createCrossrefSearch, () => new Response("private upstream details"), "failed"],
    [createGithubSearch, () => Response.json({ unrelated: true }), "failed"],
    [createCrossrefSearch, () => new Response("x".repeat(400 * 1024)), "failed"],
    [createGithubSearch, () => Response.json({ message: "private upstream details" }, { status: 403 }), "unavailable"],
    [createCrossrefSearch, () => new Response(null, { status: 504 }), "timeout"],
  ]) {
    await assert.rejects(endpoint(async () => response()).search("q", 1, signal()), (error) => {
      assert.ok(error instanceof SearchProviderError);
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /private upstream details/u);
      return true;
    });
  }
});

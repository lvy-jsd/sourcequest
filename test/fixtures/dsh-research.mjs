import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

export const name = "sourcequest-research-smoke";
export const inject = ["tools", "web"];

export async function apply(ctx) {
  ctx.web.registerSearchProvider({
    id: "sourcequest-test",
    available: () => true,
    async search({ query }, signal) {
      signal.throwIfAborted();
      if (query === "failing query") throw new Error("synthetic upstream error");
      return {
        sources: [{ url: "https://example.com/", title: "Example Domain" }],
        truncated: false,
      };
    },
  });

  for (let attempt = 0; attempt < 40 && !ctx.tools.get("net_research"); attempt++) {
    await delay(50);
  }
  assert.ok(ctx.tools.get("net_research"));
  const { results } = await ctx.tools.execute({
    signal: AbortSignal.timeout(15_000),
    calls: [{
      type: "tool-call",
      id: "sourcequest-research-smoke",
      name: "net_research",
      arguments: JSON.stringify({ queries: ["failing query", "example"], focus: "Example Domain" }),
    }],
  });
  const [entry] = results;
  assert.equal(entry.result.isError, false, JSON.stringify(entry.result));
  const value = entry.result.value;
  assert.equal(value.status, "partial", JSON.stringify(value));
  assert.deepEqual(value.issues.map(({ code }) => code), ["SEARCH_FAILED"]);
  assert.equal(value.evidence.length, 1);
  assert.equal(value.evidence[0].finalUrl, "https://example.com/");
  assert.match(value.evidence[0].title, /Example Domain/u);
  assert.match(value.evidence[0].quote, /documentation examples/u);
  console.log("sourcequest-research-smoke: search partial success and public read OK");
}

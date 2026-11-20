import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

export const name = "sourcequest-profile-smoke";
export const inject = ["tools"];

export async function apply(ctx) {
  const expected = process.env.SOURCEQUEST_SMOKE_STATE;
  assert.ok(expected === "installed" || expected === "removed");
  if (expected === "removed") {
    assert.equal(ctx.tools.get("sourcequest_status"), undefined);
  } else {
    for (let attempt = 0; attempt < 40 && !ctx.tools.get("sourcequest_status"); attempt++) {
      await delay(50);
    }
    assert.ok(ctx.tools.schemas().some(({ name }) => name === "sourcequest_status"));
    const { results } = await ctx.tools.execute({
      signal: AbortSignal.timeout(5000),
      calls: [{
        type: "tool-call",
        id: "sourcequest-smoke",
        name: "sourcequest_status",
        arguments: "{}",
      }],
    });
    assert.equal(results[0]?.result.isError, false, JSON.stringify(results[0]));
    assert.deepEqual(results[0].result.value, { plugin: "sourcequest", status: "loaded" });
  }
  console.log(`sourcequest-profile-smoke: ${expected} OK`);
}

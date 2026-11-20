import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export const name = "sourcequest-jobs-smoke";
export const inject = ["tools", "agents", "jobs", "web"];

export async function apply(ctx) {
  ctx.web.registerSearchProvider({
    id: "sourcequest-jobs-test",
    available: () => true,
    async search({ query }, signal) {
      if (query === "slow") await delay(10_000, undefined, { signal });
      return { sources: [{ url: "https://example.com/", title: "Example Domain" }], truncated: false };
    },
  });
  for (let attempt = 0; attempt < 60 && !ctx.tools.get("net_research"); attempt++) await delay(50);
  assert.ok(ctx.tools.get("net_research"));
  const owner = await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: process.cwd() } });
  const foreign = await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: process.cwd() } });
  const call = async (name, args, handle = owner) => {
    const { results } = await ctx.tools.execute({
      agent: handle.agent, signal: AbortSignal.timeout(8000),
      calls: [{ name, type: "tool-call", id: randomUUID(), arguments: JSON.stringify(args) }],
    });
    assert.equal(results[0].result.isError, false, JSON.stringify(results[0].result));
    return results[0].result.value;
  };

  try {
    let submitted;
    const args = { background: true, clientRequestId: "fixture-public", queries: ["example"] };
    for (let attempt = 0; attempt < 50; attempt++) {
      submitted = await call("net_research", args);
      if (submitted.code !== "BACKGROUND_UNAVAILABLE") break;
      await delay(50);
    }
    assert.ok(submitted.hostJobId, JSON.stringify(submitted));
    const duplicate = await call("net_research", args);
    assert.equal(duplicate.reused, true);
    assert.equal(duplicate.taskId, submitted.taskId);
    const settled = await ctx.jobs.wait(submitted.hostJobId, 7500, owner.agent.session.id);
    assert.equal(settled.status, "completed", JSON.stringify(settled));
    const results = await call("net_job", { action: "results", taskId: submitted.taskId });
    assert.equal(results.state.status, "completed", JSON.stringify(results));
    assert.equal(results.result.evidence[0].snapshotSaved, true);
    assert.deepEqual(await call("net_job", { action: "status", taskId: submitted.taskId }, foreign), {
      status: "failed", code: "TASK_NOT_FOUND",
    });

    const slow = await call("net_research", { background: true, clientRequestId: "fixture-cancel", queries: ["slow"] });
    assert.ok(slow.hostJobId, JSON.stringify(slow));
    const cancelled = await call("net_job", { action: "cancel", taskId: slow.taskId });
    assert.equal(cancelled.cancelRequested, true);
    const stopped = await ctx.jobs.wait(slow.hostJobId, 4000, owner.agent.session.id);
    assert.equal(stopped.status, "killed");
    const status = await call("net_job", { action: "status", taskId: slow.taskId });
    assert.equal(status.status, "cancelled");
    console.log("sourcequest-jobs-smoke: native submit, deduplication, result, ownership and cancellation OK");
  } finally {
    await foreign.dispose();
    await owner.dispose();
  }
}

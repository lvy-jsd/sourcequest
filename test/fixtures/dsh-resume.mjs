import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export const name = "sourcequest-resume-smoke";
export const inject = ["tools", "agents", "jobs", "web"];

const sessionId = "cbab98a3-bb48-4ea3-bdfb-5d50b30746c2";

export async function apply(ctx) {
  const stage = process.env.SOURCEQUEST_RESUME_STAGE;
  assert.ok(stage === "before" || stage === "after");
  let calls = 0;
  ctx.web.registerSearchProvider({
    id: "sourcequest-resume-test",
    available: () => true,
    async search({ query }, signal) {
      calls++;
      if (query === "pending") {
        console.log("sourcequest-resume-smoke: upstream request started");
        await delay(10_000, undefined, { signal });
      }
      return { sources: [{ url: "https://example.com/", title: "Example Domain" }], truncated: false };
    },
  });
  for (let attempt = 0; attempt < 60 && !ctx.tools.get("net_research"); attempt++) await delay(50);
  const handle = stage === "before"
    ? await ctx.agents.create({ sessionId, meta: { cwd: process.cwd() } })
    : await ctx.agents.resume({ resumeSessionId: sessionId });
  const call = async (name, args) => {
    for (let attempt = 0; attempt < 60; attempt++) {
      const { results } = await ctx.tools.execute({
        agent: handle.agent, signal: AbortSignal.timeout(8000),
        calls: [{ name, type: "tool-call", id: randomUUID(), arguments: JSON.stringify(args) }],
      });
      assert.equal(results[0].result.isError, false, JSON.stringify(results[0].result));
      const value = results[0].result.value;
      if (value.code !== "BACKGROUND_UNAVAILABLE") return value;
      await delay(50);
    }
    assert.fail("SourceQuest background tasks did not become ready");
  };
  if (stage === "before") {
    const task = await call("net_research", {
      background: true, clientRequestId: "resume-fixture", queries: ["ready", "pending"],
    });
    assert.ok(task.hostJobId, JSON.stringify(task));
    console.log(`sourcequest-resume-smoke: task ${task.taskId}`);
    return;
  }

  try {
    const taskId = process.env.SOURCEQUEST_RESUME_TASK;
    assert.match(taskId, /^[a-f0-9]{64}$/u);
    const interrupted = await call("net_job", { action: "status", taskId });
    assert.equal(interrupted.status, "interrupted", JSON.stringify(interrupted));
    const resumed = await call("net_job", { action: "resume", taskId });
    assert.ok(resumed.hostJobId, JSON.stringify(resumed));
    assert.notEqual(resumed.runId, interrupted.runId);
    const settled = await ctx.jobs.wait(resumed.hostJobId, 7500, sessionId);
    assert.equal(settled.status, "completed", JSON.stringify(settled));
    const result = await call("net_job", { action: "results", taskId });
    assert.equal(result.state.status, "partial", JSON.stringify(result));
    assert.equal(result.result.evidence[0].snapshotSaved, true);
    assert.deepEqual(result.result.issues.map(({ code }) => code), ["OUTCOME_UNKNOWN"]);
    assert.deepEqual(result.usage, {
      logicalStepsReserved: 3, logicalStepsRemaining: 3, settled: 2, pending: 0, outcomeUnknown: 1,
    });
    assert.equal(calls, 0);
    console.log("sourcequest-resume-smoke: recovered receipt, skipped unknown call and completed remaining work");
  } finally {
    await handle.dispose();
  }
}

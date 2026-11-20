import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

export const name = "sourcequest-snapshot-smoke";
export const inject = ["tools"];

function execution(id) {
  return { agent: { session: { id, requestContext: () => undefined } }, signal: AbortSignal.timeout(10_000) };
}

export async function apply(ctx) {
  for (let attempt = 0; attempt < 40 && !ctx.tools.get("net_research"); attempt++) {
    await delay(50);
  }
  const research = ctx.tools.get("net_research");
  const job = ctx.tools.get("net_job");
  assert.ok(research);
  assert.ok(job);

  const owner = execution("sourcequest-fixture-session");
  const stage = process.env.SOURCEQUEST_SNAPSHOT_STAGE;
  if (stage === "write") {
    const result = await research.execute({ urls: ["https://example.com/"] }, owner);
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(result.evidence[0].snapshotSaved, true);
    console.log(`sourcequest-snapshot-smoke: saved ${result.evidence[0].snapshotHash}`);
    return;
  }
  assert.equal(stage, "read");
  const snapshotHash = process.env.SOURCEQUEST_SNAPSHOT_HASH;
  assert.match(snapshotHash, /^[a-f0-9]{64}$/u);
  const args = { action: "evidence", snapshotHash };
  assert.deepEqual(await job.execute(args, execution("another-session")), {
    status: "failed", code: "ARTIFACT_MISSING",
  });
  const result = await job.execute(args, owner);
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.match(result.text, /documentation examples/u);
  console.log("sourcequest-snapshot-smoke: restart retrieval and owner isolation OK");
}

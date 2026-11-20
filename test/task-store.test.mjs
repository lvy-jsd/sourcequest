import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import Storage from "@deepseek-ai/dsh-storage";
import * as storageJson from "@deepseek-ai/dsh-storage-json";
import * as storageDomain from "@deepseek-ai/dsh-storage-domain";
import { DshTaskStore } from "../dist/adapters/dsh-task-store.js";

const request = { queries: ["fixture"], urls: [], focus: "" };

test("DSH storage middleware durably serializes idempotent submissions and task revisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "sourcequest-tasks-"));
  const ctx = new Context();
  const storage = ctx.plugin(Storage);
  const backend = ctx.plugin(storageJson, { root });
  const domain = ctx.plugin(storageDomain, { backend: "json" });
  let store;
  try {
    await Promise.all([storage.await(), backend.await(), domain.await()]);
    store = await DshTaskStore.open(ctx.storageDomain);
    const [first, duplicate] = await Promise.all([
      store.create("session-a", "same-key", request),
      store.create("session-a", "same-key", request),
    ]);
    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(first.run.state.taskId, duplicate.run.state.taskId);
    await assert.rejects(store.create("session-a", "same-key", { ...request, focus: "changed" }), { code: "CONFLICT" });
    const taskId = first.run.state.taskId;
    assert.throws(() => store.get("session-b", taskId), { code: "TASK_NOT_FOUND" });

    const running = await store.transition("session-a", first.run.state, "running");
    await assert.rejects(store.transition("session-a", first.run.state, "cancelled"), { code: "CONFLICT" });
    await store.close();
    store = undefined;

    store = await DshTaskStore.open(ctx.storageDomain);
    const interrupted = store.get("session-a", taskId).current.state;
    assert.equal(interrupted.status, "interrupted");
    assert.equal(interrupted.revision, running.state.revision + 1);
    const resumed = await store.resume("session-a", interrupted);
    assert.notEqual(resumed.state.runId, running.state.runId);
    assert.equal(store.get("session-a", taskId).history[0].state.runId, running.state.runId);
    await assert.rejects(store.transition("session-a", interrupted, "running"), { code: "CONFLICT" });
  } finally {
    await store?.close();
    await domain.dispose();
    await backend.dispose();
    await storage.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

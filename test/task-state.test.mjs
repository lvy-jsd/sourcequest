import assert from "node:assert/strict";
import { test } from "node:test";
import {
  budgetSchema,
  taskErrorSchema,
  taskStateChangeSchema,
  taskStateSchema,
} from "../dist/core/contracts.js";
import { changeTaskState } from "../dist/core/task-state.js";

const task = {
  schemaVersion: 1,
  taskId: "task-01",
  runId: "run-01",
  status: "running",
  revision: 3,
  eventSeq: 5,
};

test("validates versioned records and rejects ambiguous or unsafe inputs", () => {
  assert.deepEqual(taskStateSchema.parse(task), task);
  assert.equal(taskStateSchema.safeParse({ ...task, schemaVersion: 2 }).success, false);
  assert.equal(taskStateSchema.safeParse({ ...task, runId: " run-01" }).success, false);
  assert.equal(taskStateSchema.safeParse({ ...task, eventSeq: 2 ** 53 }).success, false);
  assert.equal(taskStateChangeSchema.safeParse({
    kind: "resume", runId: task.runId, expectedRevision: task.revision,
  }).success, false);
  assert.equal(budgetSchema.safeParse({
    wallTimeMs: 1500, logicalRequests: 0, concurrency: 1,
    currencyLimit: { currency: "USD", minorUnits: 0 },
  }).success, true);
  assert.equal(budgetSchema.safeParse({
    wallTimeMs: 1500, logicalRequests: -1, concurrency: 1,
  }).success, false);
  assert.equal(taskErrorSchema.safeParse({
    code: "RATE_LIMITED", scope: "attempt", retryable: true,
    retryAfterMs: 500, summary: "Source asked us to wait.",
  }).success, true);
  assert.equal(taskErrorSchema.safeParse({
    code: "RATE_LIMITED", scope: "attempt", retryable: true,
    summary: "Source asked us to wait.", rawResponse: "secret",
  }).success, false);
});

test("a terminal run stays terminal and a resumed run rejects late writes", () => {
  const transition = {
    kind: "transition", runId: task.runId, expectedRevision: task.revision, status: "partial",
  };
  const ended = changeTaskState(task, transition);
  assert.deepEqual(ended, {
    ok: true,
    state: { ...task, status: "partial", revision: 4, eventSeq: 6 },
  });
  assert.deepEqual(changeTaskState(ended.state, {
    ...transition, expectedRevision: 4, status: "completed",
  }), { ok: false, reason: "INVALID_TRANSITION" });

  const resume = { kind: "resume", runId: task.runId, expectedRevision: 4, nextRunId: "run-02" };
  assert.deepEqual(changeTaskState(ended.state, { ...resume, nextRunId: task.runId }), {
    ok: false, reason: "INVALID_TRANSITION",
  });
  const resumed = changeTaskState(ended.state, resume);
  assert.deepEqual(resumed, {
    ok: true,
    state: { ...task, runId: "run-02", status: "queued", revision: 5, eventSeq: 7 },
  });
  assert.deepEqual(changeTaskState(resumed.state, { ...transition, expectedRevision: 5 }), {
    ok: false, reason: "STALE_RUN",
  });
  assert.deepEqual(changeTaskState(resumed.state, {
    ...transition, runId: "run-02", expectedRevision: 4, status: "running",
  }), { ok: false, reason: "STALE_REVISION" });
  assert.deepEqual(changeTaskState(resumed.state, {
    ...transition, runId: "run-02", expectedRevision: 5, status: "cancelled",
  }), {
    ok: true,
    state: { ...resumed.state, status: "cancelled", revision: 6, eventSeq: 8 },
  });
});

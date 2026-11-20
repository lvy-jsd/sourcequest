import type { TaskState, TaskStateChange, TaskStatus } from "./contracts.js";

const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ["running", "cancelled", "interrupted"],
  running: ["completed", "partial", "failed", "cancelled", "needs_user_action", "interrupted"],
  needs_user_action: ["running", "cancelled", "interrupted"],
  completed: [],
  partial: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};

const resumable: readonly TaskStatus[] = ["partial", "failed", "interrupted"];

type Rejection = "STALE_RUN" | "STALE_REVISION" | "INVALID_TRANSITION" | "COUNTER_EXHAUSTED";

type ChangeResult = { ok: true; state: TaskState } | { ok: false; reason: Rejection };

// The store must authorize access, issue a fresh run ID and commit with a revision check.
export function changeTaskState(current: TaskState, change: TaskStateChange): ChangeResult {
  if (current.runId !== change.runId) return { ok: false, reason: "STALE_RUN" };
  if (current.revision !== change.expectedRevision) return { ok: false, reason: "STALE_REVISION" };

  const revision = current.revision + 1;
  const eventSeq = current.eventSeq + 1;
  if (!Number.isSafeInteger(revision) || !Number.isSafeInteger(eventSeq)) {
    return { ok: false, reason: "COUNTER_EXHAUSTED" };
  }

  switch (change.kind) {
    case "transition":
      if (!transitions[current.status].includes(change.status)) {
        return { ok: false, reason: "INVALID_TRANSITION" };
      }
      return { ok: true, state: { ...current, status: change.status, revision, eventSeq } };
    case "resume":
      if (!resumable.includes(current.status) || current.runId === change.nextRunId) {
        return { ok: false, reason: "INVALID_TRANSITION" };
      }
      return {
        ok: true,
        state: { ...current, runId: change.nextRunId, status: "queued", revision, eventSeq },
      };
  }
}

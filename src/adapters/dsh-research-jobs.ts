import type { JobId, JobOutcome, JobRegistry } from "@deepseek-ai/dsh-jobs";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { DshTaskStore, TaskStoreError } from "./dsh-task-store.js";
import type { CheckpointValue, ResearchCheckpoints, ResearchInput } from "../core/research.js";
import type { TaskState } from "../core/contracts.js";

declare module "@deepseek-ai/dsh-jobs/view" {
  interface JobKindMap {
    sourcequest: "sourcequest";
  }
}

type SessionOwner = NonNullable<ToolRunContext["agent"]>["session"]["id"];
type Owner = string;
type Executor = (
  signal: AbortSignal,
  checkpoints: ResearchCheckpoints,
) => Promise<{ status: string } & Record<string, unknown>>;
type Invocation = Pick<ToolRunContext, "callId" | "rootCallId" | "signal">;
type ActiveJob = {
  owner: Owner;
  id: JobId;
  cancel(): void;
  done: Promise<JobOutcome>;
};

export class ResearchJobs {
  private readonly active = new Map<string, ActiveJob>();
  private readonly submissions = new Set<Promise<unknown>>();
  private closed = false;

  constructor(private readonly store: DshTaskStore, private readonly jobs: JobRegistry) {}

  submit(
    owner: Owner, key: string, input: ResearchInput,
    exec: Invocation, run: Executor,
  ) {
    const submission = this.start(owner, key, input, exec, run);
    return this.track(submission);
  }

  resume(
    owner: Owner,
    taskId: string,
    exec: Invocation,
    createRun: (input: ResearchInput) => Executor,
    expectedRevision?: number,
  ) {
    return this.track(this.startResume(owner, taskId, exec, createRun, expectedRevision));
  }

  private track<T>(submission: Promise<T>): Promise<T> {
    this.submissions.add(submission);
    return submission.finally(() => this.submissions.delete(submission));
  }

  private async startResume(
    owner: Owner,
    taskId: string,
    exec: Invocation,
    createRun: (input: ResearchInput) => Executor,
    expectedRevision?: number,
  ) {
    exec.signal.throwIfAborted();
    if (this.closed) throw new TaskStoreError("CONFLICT", "The research worker is closing.");
    if (this.active.size >= 2) throw new TaskStoreError("BUDGET_EXHAUSTED", "The research workers are occupied.");
    const { current, request } = this.store.get(owner, taskId);
    if (expectedRevision !== undefined && current.state.revision !== expectedRevision) {
      throw new TaskStoreError("CONFLICT", "STALE_REVISION");
    }
    if (!["interrupted", "partial", "failed"].includes(current.state.status)) {
      throw new TaskStoreError("CONFLICT", "Only an interrupted, partial, or failed run can be resumed.");
    }
    const next = await this.store.resume(owner, current.state);
    return this.startJob(owner, next.state, exec, createRun(request));
  }

  private async start(
    owner: Owner, key: string, input: ResearchInput,
    exec: Invocation, run: Executor,
  ) {
    exec.signal.throwIfAborted();
    if (this.closed) throw new TaskStoreError("CONFLICT", "The research worker is closing.");
    const { created, run: pending } = await this.store.create(owner, key, input);
    if (!created) return { ...pending.state, reused: true };

    return this.startJob(owner, pending.state, exec, run);
  }

  private async startJob(owner: Owner, state: TaskState, exec: Invocation, run: Executor) {
    if (exec.signal.aborted || this.closed) {
      return (await this.store.transition(owner, state, "interrupted")).state;
    }
    if (this.active.size >= 2) {
      return (await this.store.transition(owner, state, "interrupted", { code: "BUDGET_EXHAUSTED" })).state;
    }

    try {
      const id = this.jobs.start({
        kind: "sourcequest",
        label: "SourceQuest web research",
        owner: owner as SessionOwner,
        toolCall: { callId: exec.callId, rootCallId: exec.rootCallId },
        run: (handle) => {
          const controller = new AbortController();
          const cancel = () => controller.abort();
          const done = this.work(owner, state, run, controller.signal)
            .catch((): JobOutcome => ({ status: "failed", detail: "Could not persist the task state." }))
            .finally(() => this.active.delete(state.taskId));
          this.active.set(state.taskId, { owner, id: handle.id, cancel, done });
          return { cancel, done };
        },
      });
      return { ...state, hostJobId: id };
    } catch {
      return (await this.store.transition(owner, state, "interrupted", { code: "BACKGROUND_UNAVAILABLE" })).state;
    }
  }

  private async work(owner: Owner, initial: TaskState, run: Executor, signal: AbortSignal): Promise<JobOutcome> {
    let state = initial;
    try {
      signal.throwIfAborted();
      state = (await this.store.transition(owner, state, "running")).state;
      signal.throwIfAborted();
      const result = await run(signal, this.store.checkpoints(owner, state));
      signal.throwIfAborted();
      const status = result.status === "completed" ? "completed" : result.status === "partial" ? "partial" : "failed";
      await this.store.transition(owner, state, status, JSON.parse(JSON.stringify(result)) as CheckpointValue);
      return { status: status === "failed" ? "failed" : "completed" };
    } catch {
      if (signal.aborted) {
        await this.store.transition(owner, state, this.closed ? "interrupted" : "cancelled");
        return { status: "killed" };
      }
      await this.store.transition(owner, state, state.status === "queued" ? "interrupted" : "failed", {
        code: "RESEARCH_FAILED",
      });
      return { status: "failed" };
    }
  }

  status(owner: Owner, taskId: string) {
    return this.store.get(owner, taskId).current.state;
  }

  list(owner: Owner, options?: { limit?: number; cursor?: string }) {
    return this.store.list(owner, options);
  }

  result(owner: Owner, taskId: string) {
    return this.store.result(owner, taskId);
  }

  cancel(owner: Owner, taskId: string) {
    const { state } = this.store.get(owner, taskId).current;
    const live = this.active.get(taskId);
    if (!live || live.owner !== owner) return { state, cancelRequested: false };
    const request = this.jobs.kill(live.id, owner as SessionOwner);
    return { state, cancelRequested: request === "requested" };
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.submissions);
    const active = [...this.active.values()];
    for (const entry of active) entry.cancel();
    await Promise.allSettled(active.map(({ done }) => done));
    await this.store.close();
  }
}

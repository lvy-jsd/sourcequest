import { randomUUID } from "node:crypto";
import { defineDomain, domainTable, type Domain, type DomainFacility } from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";
import { schemaVersion, taskStateSchema, type TaskState, type TaskStatus } from "../core/contracts.js";
import { researchRequestSchema, type CheckpointValue, type ResearchCheckpoints, type ResearchInput, type Reservation } from "../core/research.js";
import { snapshotHash } from "../core/snapshot-store.js";
import { changeTaskState } from "../core/task-state.js";

const domainName = "sourcequest_tasks";
const clientRequestId = z.string().regex(/^[a-zA-Z0-9_.:-]{1,96}$/u);
const taskIdSchema = z.hash("sha256");
const persistedRun = z.strictObject({
  state: taskStateSchema,
  result: z.json().optional(),
});
const checkpointLimit = 6;
const stepIdSchema = z.string().regex(/^(search|read):[0-2]$/u);
const checkpointSchema = z.strictObject({
  id: stepIdSchema,
  runId: z.uuid(),
  receipt: z.json().optional(),
});
const recordSchema = z.strictObject({
  owner: z.hash("sha256"),
  request: researchRequestSchema,
  current: persistedRun,
  history: z.array(persistedRun).max(7),
  checkpoints: z.array(checkpointSchema).max(checkpointLimit).optional(),
});
type ResearchRecord = z.infer<typeof recordSchema>;
type ResearchRun = z.infer<typeof persistedRun>;

const spec = defineDomain({
  name: domainName,
  version: schemaVersion,
  layout: "per-record",
  tables: { tasks: domainTable(recordSchema) },
});

type ErrorCode = "INVALID_REQUEST" | "TASK_NOT_FOUND" | "CONFLICT" | "BUDGET_EXHAUSTED" | "OUTCOME_UNKNOWN";
export class TaskStoreError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
  }
}

export class DshTaskStore {
  private creationQueue: Promise<unknown> = Promise.resolve();

  private constructor(private readonly domain: Domain<typeof spec>) {}

  static async open(facility: DomainFacility): Promise<DshTaskStore> {
    const store = new DshTaskStore(await facility.open(spec));
    try {
      await store.recoverInterrupted();
      return store;
    } catch (error) {
      await store.close();
      throw error;
    }
  }

  private get tasks() {
    return this.domain.table("tasks");
  }

  private async recoverInterrupted(): Promise<void> {
    for (const [id, { current }] of this.tasks.entries()) {
      if (!["queued", "running", "needs_user_action"].includes(current.state.status)) continue;
      await this.tasks.update(id, (record) => {
        const changed = changeTaskState(record.current.state, {
          kind: "transition", runId: current.state.runId, expectedRevision: current.state.revision,
          status: "interrupted",
        });
        if (!changed.ok) throw new TaskStoreError("CONFLICT", changed.reason);
        return { ...record, current: { ...record.current, state: changed.state } };
      });
    }
  }

  async create(owner: string, key: string, request: ResearchInput): Promise<{ created: boolean; run: ResearchRun }> {
    if (!owner || !clientRequestId.safeParse(key).success) {
      throw new TaskStoreError("INVALID_REQUEST", "A session and a bounded request ID are required.");
    }
    const parsed = researchRequestSchema.parse(request);
    const ownerHash = snapshotHash(owner);
    const taskId = snapshotHash(JSON.stringify([owner, key]));
    const creation = this.creationQueue.then(async () => {
      const existing = this.tasks.get(taskId);
      if (existing) {
        if (existing.owner !== ownerHash || JSON.stringify(existing.request) !== JSON.stringify(parsed)) {
          throw new TaskStoreError("CONFLICT", "The request ID already belongs to different input.");
        }
        return { created: false, run: existing.current };
      }

      let ownerRecords = 0;
      for (const [, entry] of this.tasks.entries()) if (entry.owner === ownerHash) ownerRecords++;
      if (this.tasks.size >= 2048 || ownerRecords >= 128) {
        throw new TaskStoreError("BUDGET_EXHAUSTED", "The task store has reached its record limit.");
      }
      const state: TaskState = {
        schemaVersion, taskId, runId: randomUUID(), status: "queued", revision: 0, eventSeq: 0,
      };
      const current = { state };
      await this.tasks.put(taskId, { owner: ownerHash, request: parsed, current, history: [], checkpoints: [] });
      return { created: true, run: current };
    });
    this.creationQueue = creation.catch(() => undefined);
    return creation;
  }

  get(owner: string, taskId: string): ResearchRecord {
    const record = taskIdSchema.safeParse(taskId).success ? this.tasks.get(taskId) : undefined;
    if (!owner || record?.owner !== snapshotHash(owner)) {
      throw new TaskStoreError("TASK_NOT_FOUND", "No task is available in this session.");
    }
    return record;
  }

  result(owner: string, taskId: string) {
    const { current, checkpoints } = this.get(owner, taskId);
    if (!checkpoints) return current;

    const settled = checkpoints.filter((entry) => entry.receipt !== undefined).length;
    const pending = current.state.status === "running"
      ? checkpoints.filter((entry) => entry.runId === current.state.runId && entry.receipt === undefined).length
      : 0;
    return {
      ...current,
      usage: {
        logicalStepsReserved: checkpoints.length,
        logicalStepsRemaining: checkpointLimit - checkpoints.length,
        settled,
        pending,
        outcomeUnknown: checkpoints.length - settled - pending,
      },
    };
  }

  async transition(
    owner: string, current: TaskState, status: TaskStatus, result?: CheckpointValue,
  ): Promise<ResearchRun> {
    this.get(owner, current.taskId);
    const next = await this.tasks.update(current.taskId, (record) => {
      const changed = changeTaskState(record.current.state, {
        kind: "transition", runId: current.runId, expectedRevision: current.revision, status,
      });
      if (!changed.ok) throw new TaskStoreError("CONFLICT", changed.reason);
      const run = result === undefined ? { state: changed.state } : { state: changed.state, result };
      return { ...record, current: run };
    });
    return next.current;
  }

  checkpoints(owner: string, state: TaskState): ResearchCheckpoints {
    this.get(owner, state.taskId);
    return {
      reserve: async (id) => {
        stepIdSchema.parse(id);
        let decision: Reservation = "exhausted";
        await this.tasks.update(state.taskId, (record) => {
          const entries = this.activeCheckpoints(record, state);
          const existing = entries.find((checkpoint) => checkpoint.id === id);
          if (existing) {
            decision = existing.receipt === undefined ? "unknown" : { receipt: existing.receipt };
            return record;
          }
          if (entries.length >= checkpointLimit) return record;
          decision = "run";
          return { ...record, checkpoints: [...entries, { id, runId: state.runId }] };
        });
        return decision;
      },
      settle: async (id, receipt) => {
        await this.tasks.update(state.taskId, (record) => {
          const entries = this.activeCheckpoints(record, state);
          const entry = entries.find((checkpoint) => checkpoint.id === id);
          if (!entry || entry.runId !== state.runId || entry.receipt !== undefined) {
            throw new TaskStoreError("CONFLICT", "The current run does not own this reservation.");
          }
          return { ...record, checkpoints: entries.map((checkpoint) =>
            checkpoint === entry ? { ...entry, receipt } : checkpoint) };
        });
      },
    };
  }

  private activeCheckpoints(record: ResearchRecord, state: TaskState) {
    if (record.current.state.runId !== state.runId || record.current.state.status !== "running") {
      throw new TaskStoreError("CONFLICT", "The run is no longer active.");
    }
    if (!record.checkpoints) {
      throw new TaskStoreError("OUTCOME_UNKNOWN", "This task predates persisted call reservations.");
    }
    return record.checkpoints;
  }

  async resume(owner: string, current: TaskState): Promise<ResearchRun> {
    this.get(owner, current.taskId);
    const next = await this.tasks.update(current.taskId, (record) => {
      if (!record.checkpoints) {
        throw new TaskStoreError("OUTCOME_UNKNOWN", "This task predates persisted call reservations.");
      }
      if (record.history.length >= 7) throw new TaskStoreError("BUDGET_EXHAUSTED", "The run limit was reached.");
      const changed = changeTaskState(record.current.state, {
        kind: "resume", runId: current.runId, expectedRevision: current.revision, nextRunId: randomUUID(),
      });
      if (!changed.ok) throw new TaskStoreError("CONFLICT", changed.reason);
      return { ...record, current: { state: changed.state }, history: [...record.history, record.current] };
    });
    return next.current;
  }

  close(): Promise<void> {
    return this.domain.close();
  }
}

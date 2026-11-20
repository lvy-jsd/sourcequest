import { randomUUID } from "node:crypto";
import { defineDomain, domainTable, type Domain, type DomainFacility } from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";
import { schemaVersion, taskStateSchema, type TaskState, type TaskStatus } from "../core/contracts.js";
import { researchRequestSchema, type ResearchInput } from "../core/research.js";
import { snapshotHash } from "../core/snapshot-store.js";
import { changeTaskState } from "../core/task-state.js";

const domainName = "sourcequest_tasks";
const clientRequestId = z.string().regex(/^[a-zA-Z0-9_.:-]{1,96}$/u);
const taskIdSchema = z.hash("sha256");
const persistedRun = z.strictObject({
  state: taskStateSchema,
  result: z.json().optional(),
});
const recordSchema = z.strictObject({
  owner: z.hash("sha256"),
  request: researchRequestSchema,
  current: persistedRun,
  history: z.array(persistedRun).max(7),
});
type ResearchRecord = z.infer<typeof recordSchema>;
type ResearchRun = z.infer<typeof persistedRun>;

const spec = defineDomain({
  name: domainName,
  version: schemaVersion,
  layout: "per-record",
  tables: { tasks: domainTable(recordSchema) },
});

type ErrorCode = "INVALID_REQUEST" | "TASK_NOT_FOUND" | "CONFLICT" | "BUDGET_EXHAUSTED";
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
      await this.tasks.put(taskId, { owner: ownerHash, request: parsed, current, history: [] });
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

  async transition(
    owner: string, current: TaskState, status: TaskStatus, result?: z.infer<ReturnType<typeof z.json>>,
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

  async resume(owner: string, current: TaskState): Promise<ResearchRun> {
    this.get(owner, current.taskId);
    const next = await this.tasks.update(current.taskId, (record) => {
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

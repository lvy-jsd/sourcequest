import type { CapabilityRegistry } from "../core/capability-registry.js";
import type { SnapshotStore } from "../core/snapshot-store.js";
import type { ResearchJobs } from "./dsh-research-jobs.js";
import type { DshTaskStore } from "./dsh-task-store.js";
import { runDoctor, exportTaskEvidence, type DoctorDeps, type DoctorReport } from "./dsh-doctor.js";

export type PolicySettings = {
  revision: number;
  defaultStrategy: "quick" | "balanced" | "deep";
  allowFallback: boolean;
  strictCostCap: boolean;
  explicitWebProviderEnabled: boolean;
};

export type RpcError = {
  ok: false;
  status: 400 | 401 | 403 | 404 | 409 | 500;
  code: string;
  message: string;
};

export type RpcResult<T> = { ok: true; data: T } | RpcError;

export type SourceQuestRpcDeps = {
  registry: CapabilityRegistry;
  snapshots: () => SnapshotStore;
  taskStore?: () => DshTaskStore | undefined;
  jobs?: () => ResearchJobs | undefined;
  doctorDeps?: DoctorDeps;
};

export class SourceQuestRpcService {
  private policy: PolicySettings = {
    revision: 1,
    defaultStrategy: "balanced",
    allowFallback: true,
    strictCostCap: false,
    explicitWebProviderEnabled: false,
  };

  constructor(private readonly deps: SourceQuestRpcDeps) {}

  private requireOwner(owner: string | undefined): owner is string {
    return typeof owner === "string" && owner.trim().length > 0;
  }

  listSources(owner: string | undefined): RpcResult<{ policyRevision: string; sources: ReturnType<CapabilityRegistry["list"]> }> {
    if (!this.requireOwner(owner)) {
      return { ok: false, status: 401, code: "AUTH_REQUIRED", message: "Authenticated DSH session required." };
    }
    return {
      ok: true,
      data: {
        policyRevision: this.deps.registry.policyRevision(),
        sources: this.deps.registry.list(),
      },
    };
  }

  toggleSource(
    owner: string | undefined,
    params: { id: string; enabled: boolean; expectedRevision?: string },
  ): RpcResult<{ policyRevision: string }> {
    if (!this.requireOwner(owner)) {
      return { ok: false, status: 401, code: "AUTH_REQUIRED", message: "Authenticated DSH session required." };
    }
    if (params.expectedRevision && params.expectedRevision !== this.deps.registry.policyRevision()) {
      return {
        ok: false,
        status: 409,
        code: "REVISION_CONFLICT",
        message: "Policy revision changed concurrently; refresh before saving.",
      };
    }
    try {
      this.deps.registry.setEnabled(params.id, params.enabled);
      return { ok: true, data: { policyRevision: this.deps.registry.policyRevision() } };
    } catch {
      return { ok: false, status: 404, code: "NOT_FOUND", message: `Unknown capability: ${params.id}` };
    }
  }

  getPolicy(owner: string | undefined): RpcResult<PolicySettings> {
    if (!this.requireOwner(owner)) {
      return { ok: false, status: 401, code: "AUTH_REQUIRED", message: "Authenticated DSH session required." };
    }
    return { ok: true, data: { ...this.policy } };
  }

  updatePolicy(
    owner: string | undefined,
    patch: Partial<Omit<PolicySettings, "revision">> & { expectedRevision: number },
  ): RpcResult<PolicySettings> {
    if (!this.requireOwner(owner)) {
      return { ok: false, status: 401, code: "AUTH_REQUIRED", message: "Authenticated DSH session required." };
    }
    if (patch.expectedRevision !== this.policy.revision) {
      return {
        ok: false,
        status: 409,
        code: "REVISION_CONFLICT",
        message: `Expected policy revision ${this.policy.revision}, received ${patch.expectedRevision}.`,
      };
    }
    this.policy = {
      revision: this.policy.revision + 1,
      defaultStrategy: patch.defaultStrategy ?? this.policy.defaultStrategy,
      allowFallback: patch.allowFallback ?? this.policy.allowFallback,
      strictCostCap: patch.strictCostCap ?? this.policy.strictCostCap,
      explicitWebProviderEnabled: patch.explicitWebProviderEnabled ?? this.policy.explicitWebProviderEnabled,
    };
    return { ok: true, data: { ...this.policy } };
  }

  listTasks(owner: string | undefined, options?: { limit?: number; cursor?: string }): RpcResult<unknown> {
    if (!this.requireOwner(owner)) {
      return { ok: false, status: 401, code: "AUTH_REQUIRED", message: "Authenticated DSH session required." };
    }
    const store = this.deps.taskStore?.();
    if (!store) {
      return { ok: true, data: { items: [], nextCursor: undefined } };
    }
    return { ok: true, data: store.list(owner, options) };
  }

  getTask(owner: string | undefined, taskId: string): RpcResult<unknown> {
    if (!this.requireOwner(owner)) {
      return { ok: false, status: 401, code: "AUTH_REQUIRED", message: "Authenticated DSH session required." };
    }
    const jobs = this.deps.jobs?.();
    if (!jobs) {
      return { ok: false, status: 404, code: "TASK_NOT_FOUND", message: "Task store unavailable." };
    }
    try {
      return { ok: true, data: jobs.result(owner, taskId) };
    } catch {
      return { ok: false, status: 404, code: "TASK_NOT_FOUND", message: "Task not found in current session." };
    }
  }

  cancelTask(owner: string | undefined, taskId: string): RpcResult<unknown> {
    if (!this.requireOwner(owner)) {
      return { ok: false, status: 401, code: "AUTH_REQUIRED", message: "Authenticated DSH session required." };
    }
    const jobs = this.deps.jobs?.();
    if (!jobs) {
      return { ok: false, status: 404, code: "TASK_NOT_FOUND", message: "Task store unavailable." };
    }
    try {
      return { ok: true, data: jobs.cancel(owner, taskId) };
    } catch {
      return { ok: false, status: 404, code: "TASK_NOT_FOUND", message: "Task not found in current session." };
    }
  }

  readEvidence(owner: string | undefined, snapshotHash: string, offset = 0): RpcResult<{ text: string; length: number }> {
    if (!this.requireOwner(owner)) {
      return { ok: false, status: 401, code: "AUTH_REQUIRED", message: "Authenticated DSH session required." };
    }
    const doc = this.deps.snapshots().read(owner, snapshotHash);
    if (doc === undefined) {
      return { ok: false, status: 404, code: "ARTIFACT_MISSING", message: "Snapshot missing for this session." };
    }
    const start = Math.max(0, Math.min(offset, doc.length));
    const end = Math.min(doc.length, start + 3000);
    return { ok: true, data: { text: doc.slice(start, end), length: doc.length } };
  }

  exportTask(owner: string | undefined, taskId: string, publicOnly = true): RpcResult<unknown> {
    if (!this.requireOwner(owner)) {
      return { ok: false, status: 401, code: "AUTH_REQUIRED", message: "Authenticated DSH session required." };
    }
    const store = this.deps.taskStore?.();
    if (!store) {
      return { ok: false, status: 404, code: "TASK_NOT_FOUND", message: "Task store unavailable." };
    }
    try {
      return { ok: true, data: exportTaskEvidence(owner, taskId, store, this.deps.snapshots(), { publicOnly }) };
    } catch {
      return { ok: false, status: 404, code: "TASK_NOT_FOUND", message: "Task not found in current session." };
    }
  }

  async doctor(owner: string | undefined): Promise<RpcResult<DoctorReport>> {
    if (!this.requireOwner(owner)) {
      return { ok: false, status: 401, code: "AUTH_REQUIRED", message: "Authenticated DSH session required." };
    }
    const report = await runDoctor(
      this.deps.doctorDeps ?? {
        registry: this.deps.registry,
        snapshots: this.deps.snapshots,
        hasTaskStore: Boolean(this.deps.taskStore?.()),
      },
    );
    return { ok: true, data: report };
  }
}

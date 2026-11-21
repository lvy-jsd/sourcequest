import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CapabilityRegistry } from "../core/capability-registry.js";
import type { SnapshotStore } from "../core/snapshot-store.js";
import type { DshTaskStore } from "./dsh-task-store.js";

const execFileAsync = promisify(execFile);

export type OptionalBinaryCheck = {
  name: string;
  capabilityId: string;
  available: boolean;
  hint: string;
};

export type DoctorReport = {
  ok: boolean;
  checkedAt: string;
  coreReady: boolean;
  hostWebReady?: boolean;
  hostLlmReady?: boolean;
  taskStoreReady: boolean;
  snapshotStats: ReturnType<SnapshotStore["stats"]>;
  unconfiguredSources: readonly string[];
  disabledSources: readonly string[];
  optionalDependencies: readonly OptionalBinaryCheck[];
  warnings: readonly string[];
};

export type DoctorDeps = {
  registry: CapabilityRegistry;
  snapshots: () => SnapshotStore;
  hasTaskStore: boolean;
  checkWebReady?: () => Promise<boolean>;
  checkLlmReady?: () => Promise<boolean>;
  checkBinary?: (name: string) => Promise<boolean>;
};

const optionalBinaries: readonly { name: string; capabilityId: string; hint: string }[] = [
  { name: "google-chrome", capabilityId: "playwright", hint: "Install Chrome/Chromium or Playwright for JS browser execution." },
  { name: "pdftotext", capabilityId: "pdf-ocr", hint: "Install poppler-utils / Docling for PDF layout & text extraction." },
  { name: "tesseract", capabilityId: "pdf-ocr", hint: "Install tesseract OCR for scanned PDF/image parsing." },
  { name: "yt-dlp", capabilityId: "batch-queue", hint: "Install yt-dlp for VOD/media stream manifest probing." },
  { name: "ffmpeg", capabilityId: "batch-queue", hint: "Install ffmpeg for media/livestream muxing & segmenting." },
  { name: "aria2c", capabilityId: "batch-queue", hint: "Install aria2 for multi-connection resumable archive downloads." },
  { name: "gallery-dl", capabilityId: "batch-queue", hint: "Install gallery-dl for ordered image gallery fetching." },
];

async function defaultCheckBinary(name: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("which", [name], { timeout: 1500 });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const probeBinary = deps.checkBinary ?? defaultCheckBinary;
  const entries = deps.registry.list();
  const unconfiguredSources = entries
    .filter((e) => e.requiresAuth && !e.credentialConfigured)
    .map((e) => e.id);
  const disabledSources = entries.filter((e) => !e.enabled).map((e) => e.id);

  let hostWebReady: boolean | undefined;
  let hostLlmReady: boolean | undefined;
  const warnings: string[] = [];

  if (deps.checkWebReady) {
    try {
      hostWebReady = await deps.checkWebReady();
      if (!hostWebReady) warnings.push("Host web search provider is not ready or missing credentials.");
    } catch {
      hostWebReady = false;
      warnings.push("Failed to query host web readiness.");
    }
  }
  if (deps.checkLlmReady) {
    try {
      hostLlmReady = await deps.checkLlmReady();
      if (!hostLlmReady) warnings.push("Host LLM service is unavailable; rule-based planner fallback will be used.");
    } catch {
      hostLlmReady = false;
      warnings.push("Failed to query host LLM readiness.");
    }
  }

  if (unconfiguredSources.length > 0) {
    warnings.push(`Auth-gated connectors lack credentials (staying disabled): ${unconfiguredSources.join(", ")}`);
  }

  const optionalDependencies = await Promise.all(
    optionalBinaries.map(async (item) => ({
      name: item.name,
      capabilityId: item.capabilityId,
      available: await probeBinary(item.name),
      hint: item.hint,
    })),
  );

  let snapshotStats: ReturnType<SnapshotStore["stats"]>;
  try {
    snapshotStats = deps.snapshots().stats();
  } catch {
    snapshotStats = { snapshots: 0, snapshotBytes: 0, artifacts: 0, artifactBytes: 0 };
    warnings.push("Snapshot store could not be inspected.");
  }

  return {
    ok: deps.hasTaskStore && hostWebReady !== false,
    checkedAt: new Date().toISOString(),
    coreReady: true,
    hostWebReady,
    hostLlmReady,
    taskStoreReady: deps.hasTaskStore,
    snapshotStats,
    unconfiguredSources,
    disabledSources,
    optionalDependencies,
    warnings,
  };
}

export function exportTaskEvidence(
  owner: string,
  taskId: string,
  taskStore: DshTaskStore,
  snapshots: SnapshotStore,
  options: { publicOnly?: boolean } = {},
): {
  exportedAt: string;
  taskId: string;
  status: string;
  revision: number;
  result: unknown;
  snapshots: Record<string, string>;
  publicOnly: boolean;
} {
  const { current } = taskStore.get(owner, taskId);
  const serialized = JSON.stringify(current.result ?? {});
  const hashes = [...new Set(serialized.match(/[a-f0-9]{64}/gu) ?? [])];
  const snapshotMap: Record<string, string> = {};
  for (const h of hashes) {
    const body = snapshots.read(owner, h);
    if (body !== undefined) {
      snapshotMap[h] = options.publicOnly
        ? body.replace(/(?:Bearer|token|sk-|ghp_)[A-Za-z0-9._-]+/giu, "[REDACTED]")
        : body;
    }
  }
  return {
    exportedAt: new Date().toISOString(),
    taskId: current.state.taskId,
    status: current.state.status,
    revision: current.state.revision,
    result: current.result ?? null,
    snapshots: snapshotMap,
    publicOnly: options.publicOnly ?? true,
  };
}

export function deleteSessionEvidence(owner: string, snapshots: SnapshotStore): {
  snapshotsDeleted: number;
  artifactsDeleted: number;
} {
  return snapshots.deleteOwnerData(owner);
}

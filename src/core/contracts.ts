import { z } from "zod";

export const schemaVersion = 1;

const identifier = z.string().min(1).max(256).regex(/^\S+$/);
const counter = z.int().nonnegative();

export const taskStatusSchema = z.enum([
  "queued",
  "running",
  "needs_user_action",
  "completed",
  "partial",
  "failed",
  "cancelled",
  "interrupted",
]);

export const taskStateSchema = z.strictObject({
  schemaVersion: z.literal(schemaVersion),
  taskId: identifier,
  runId: identifier,
  status: taskStatusSchema,
  revision: counter,
  eventSeq: counter,
});

export const taskStateChangeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("transition"),
    runId: identifier,
    expectedRevision: counter,
    status: taskStatusSchema,
  }),
  z.strictObject({
    kind: z.literal("resume"),
    runId: identifier,
    expectedRevision: counter,
    nextRunId: identifier,
  }),
]);

export const budgetSchema = z.strictObject({
  wallTimeMs: z.int().positive(),
  logicalRequests: counter,
  knownBackendCalls: counter.optional(),
  modelInputTokens: counter.optional(),
  modelOutputTokens: counter.optional(),
  pages: counter.optional(),
  browserSteps: counter.optional(),
  bytes: counter.optional(),
  concurrency: z.int().positive(),
  currencyLimit: z.strictObject({
    currency: z.string().regex(/^[A-Z]{3}$/),
    minorUnits: counter,
  }).optional(),
});

export const taskErrorSchema = z.strictObject({
  code: z.enum([
    "INVALID_REQUEST",
    "UNSUPPORTED_CONSTRAINT",
    "NOT_CONFIGURED",
    "AUTH_REQUIRED",
    "RATE_LIMITED",
    "TIMEOUT",
    "CANCELLED",
    "EMPTY_RESULT",
    "UNUSABLE_BODY",
    "UNSUPPORTED_MIME",
    "BUDGET_EXHAUSTED",
    "STORAGE_FAILED",
    "ARTIFACT_MISSING",
    "OUTCOME_UNKNOWN",
  ]),
  scope: z.enum(["task", "run", "step", "attempt"]),
  retryable: z.boolean(),
  retryAfterMs: counter.optional(),
  // Callers supply a public summary, without raw responses or credentials.
  summary: z.string().trim().min(1).max(512),
});

export const executionIdentitySchema = z.strictObject({
  taskId: identifier,
  runId: identifier,
  stepId: identifier,
  attemptId: identifier,
  owner: z.string().min(1).max(256),
});

export const currencyCostSchema = z.strictObject({
  kind: z.enum(["actual", "estimated", "unknown"]),
  currency: z.string().regex(/^[A-Z]{3}$/),
  minorUnits: counter.optional(),
  source: z.string().min(1).max(128),
  recordedAt: z.iso.datetime(),
});

export const sourceRecordSchema = z.strictObject({
  sourceId: identifier,
  providerId: z.string().min(1).max(128),
  upstreamFamily: z.string().min(1).max(128),
  requestedUrl: z.url(),
  finalUrl: z.url(),
  canonicalUrl: z.url(),
  title: z.string().max(300),
  publishedAt: z.iso.datetime().optional(),
  rawTimeText: z.string().max(128).optional(),
  version: z.string().max(128).optional(),
});

export const snapshotRecordSchema = z.strictObject({
  snapshotId: identifier,
  sourceId: identifier,
  fetchedAt: z.iso.datetime(),
  mime: z.string().min(1).max(128),
  encoding: z.string().min(1).max(64),
  hash: z.hash("sha256"),
  artifactRef: z.string().min(1).max(256),
  extractor: z.string().min(1).max(128),
  parserVersion: z.string().min(1).max(64),
  versionKind: z.enum(["raw", "normalized"]),
  truncated: z.boolean(),
});

export const anchorSchema = z.strictObject({
  snapshotHash: z.hash("sha256"),
  versionKind: z.enum(["raw", "normalized"]),
  coordinateSpace: z.string().min(1).max(64),
  start: counter.optional(),
  end: z.int().positive().optional(),
  page: z.int().positive().optional(),
  section: z.string().max(256).optional(),
  tableCell: z.string().max(64).optional(),
  timestampSec: z.number().nonnegative().optional(),
});

export const evidenceRecordSchema = z.strictObject({
  evidenceId: identifier,
  sourceId: identifier,
  tier: z.enum(["primary_quote", "summary", "metadata"]),
  anchor: anchorSchema,
  quote: z.string().min(1).max(2000),
  quality: z.enum(["verified", "usable", "degraded", "shell", "auth_wall"]),
  scope: z.string().min(1).max(256),
  snapshotSaved: z.boolean(),
});

export const claimRecordSchema = z.strictObject({
  claimId: identifier,
  subQuestionId: identifier,
  kind: z.enum(["fact", "inference", "unknown"]),
  statement: z.string().min(1).max(2000),
  evidenceIds: z.array(identifier).max(64),
  applicableDate: z.string().max(128).optional(),
  applicableVersion: z.string().max(128).optional(),
  verificationStatus: z.enum(["verified", "unverified", "conflicted"]),
  conflictNote: z.string().max(512).optional(),
});

export const subQuestionCoverageSchema = z.strictObject({
  subQuestionId: identifier,
  question: z.string().min(1).max(512),
  status: z.enum(["solved", "partial", "unresolved"]),
  evidenceIds: z.array(identifier).max(64),
  claimIds: z.array(identifier).max(64),
  unresolvedReason: z.string().max(512).optional(),
});

export const routingCandidateSchema = z.strictObject({
  id: z.string().min(1).max(128),
  accepted: z.boolean(),
  reason: z.string().min(1).max(256),
});

export const routingDecisionSchema = z.strictObject({
  policyRevision: z.string().min(1).max(64),
  layer: z.enum(["source", "executor", "model"]),
  selectedId: z.string().min(1).max(128).optional(),
  fallbackAllowed: z.boolean(),
  candidates: z.array(routingCandidateSchema).max(64),
  rationale: z.string().min(1).max(512),
});

export const fullResearchRequestSchema = z.strictObject({
  schemaVersion: z.int().positive().default(schemaVersion),
  clientRequestId: z.string().regex(/^[a-zA-Z0-9_.:-]{1,96}$/u).optional(),
  goal: z.string().trim().min(1).max(2000).optional(),
  intent: z.enum(["auto", "search", "read", "research", "crawl", "browse"]).default("auto"),
  urls: z.array(z.string().trim().min(1).max(2048)).max(16).default([]),
  queries: z.array(z.string().trim().min(1).max(250)).max(12).default([]),
  focus: z.string().trim().max(500).default(""),
  topic: z.string().trim().max(128).optional(),
  constraints: z.strictObject({
    dateFrom: z.string().max(64).optional(),
    dateTo: z.string().max(64).optional(),
    domains: z.array(z.string().min(1).max(256)).max(16).optional(),
    language: z.string().max(32).optional(),
    version: z.string().max(64).optional(),
    strictCostCap: z.boolean().optional(),
    requirePrimaryEvidence: z.boolean().optional(),
    forceRefresh: z.boolean().optional(),
  }).optional(),
  strategy: z.enum(["quick", "balanced", "deep"]).default("balanced"),
  overrides: z.strictObject({
    source: z.string().min(1).max(128).optional(),
    model: z.string().min(1).max(128).optional(),
    executor: z.string().min(1).max(128).optional(),
    allowFallback: z.boolean().optional(),
  }).optional(),
  source: z.enum(["auto", "host", "github", "crossref"]).optional(),
  allowFallback: z.boolean().optional(),
  budget: budgetSchema.partial().optional(),
  output: z.strictObject({
    compact: z.boolean().optional(),
    includeCounterEvidence: z.boolean().optional(),
    maxSummaryChars: z.int().positive().max(16000).optional(),
    format: z.enum(["json", "markdown"]).optional(),
  }).optional(),
  background: z.boolean().optional(),
}).refine(
  ({ goal, urls, queries }) => Boolean(goal) || urls.length > 0 || queries.length > 0,
  "At least one of goal, urls, or queries is required.",
);

export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type TaskState = Readonly<z.infer<typeof taskStateSchema>>;
export type TaskStateChange = Readonly<z.infer<typeof taskStateChangeSchema>>;
export type Budget = z.infer<typeof budgetSchema>;
export type TaskError = z.infer<typeof taskErrorSchema>;
export type ExecutionIdentity = z.infer<typeof executionIdentitySchema>;
export type CurrencyCost = z.infer<typeof currencyCostSchema>;
export type SourceRecord = z.infer<typeof sourceRecordSchema>;
export type SnapshotRecord = z.infer<typeof snapshotRecordSchema>;
export type Anchor = z.infer<typeof anchorSchema>;
export type EvidenceRecord = z.infer<typeof evidenceRecordSchema>;
export type ClaimRecord = z.infer<typeof claimRecordSchema>;
export type SubQuestionCoverage = z.infer<typeof subQuestionCoverageSchema>;
export type RoutingCandidate = z.infer<typeof routingCandidateSchema>;
export type RoutingDecision = z.infer<typeof routingDecisionSchema>;
export type FullResearchRequest = z.infer<typeof fullResearchRequestSchema>;

export type MigrationResult<T> =
  | { ok: true; migrated: boolean; fromVersion: number; toVersion: number; record: T }
  | { ok: false; code: "UNSUPPORTED_SCHEMA_VERSION" | "INVALID_RECORD"; message: string };

export function migrateTaskRecord<T extends Record<string, unknown>>(
  raw: unknown,
): MigrationResult<T & { schemaVersion: number }> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, code: "INVALID_RECORD", message: "Task record must be an object." };
  }
  const obj = raw as Record<string, unknown>;
  const ver = obj.schemaVersion === undefined ? 0 : obj.schemaVersion;
  if (typeof ver !== "number" || !Number.isInteger(ver) || ver < 0) {
    return { ok: false, code: "INVALID_RECORD", message: "Invalid schemaVersion field." };
  }
  if (ver > schemaVersion) {
    return {
      ok: false,
      code: "UNSUPPORTED_SCHEMA_VERSION",
      message: `Schema version ${ver} is newer than supported version ${schemaVersion}. Refusing destructive downgrade.`,
    };
  }
  if (ver === schemaVersion) {
    return {
      ok: true,
      migrated: false,
      fromVersion: ver,
      toVersion: schemaVersion,
      record: obj as T & { schemaVersion: number },
    };
  }
  return {
    ok: true,
    migrated: true,
    fromVersion: ver,
    toVersion: schemaVersion,
    record: { ...obj, schemaVersion } as T & { schemaVersion: number },
  };
}

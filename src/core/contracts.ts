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

export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type TaskState = Readonly<z.infer<typeof taskStateSchema>>;
export type TaskStateChange = Readonly<z.infer<typeof taskStateChangeSchema>>;
export type Budget = z.infer<typeof budgetSchema>;
export type TaskError = z.infer<typeof taskErrorSchema>;

import type {
  Budget,
  ClaimRecord,
  CurrencyCost,
  EvidenceRecord,
  ExecutionIdentity,
  RoutingDecision,
  SnapshotRecord,
  SourceRecord,
  SubQuestionCoverage,
  TaskError,
  TaskState,
} from "../core/contracts.js";

export type PortCallContext = {
  identity: ExecutionIdentity;
  signal: AbortSignal;
  deadlineMs: number;
  authContext: "public" | "authenticated";
};

export type SearchQueryConstraints = {
  dateFrom?: string;
  dateTo?: string;
  domains?: readonly string[];
  language?: string;
  topic?: string;
};

export type SearchPortHit = {
  url: string;
  title?: string;
  snippet?: string;
  publishedAt?: string;
  rawTimeText?: string;
  providerId?: string;
  upstreamFamily?: string;
};

export type SearchPortReceipt = {
  providerId: string;
  upstreamFamily: string;
  logicalRequests: number;
  knownBackendCalls?: number;
  backendCallsUnknown: boolean;
  durationMs: number;
  cost: CurrencyCost;
  supportedFilters: readonly (keyof SearchQueryConstraints)[];
};

export type SearchPortResult = {
  hits: readonly SearchPortHit[];
  receipt: SearchPortReceipt;
};

export interface SearchPort {
  readonly id: string;
  readonly upstreamFamily: string;
  readonly supportedFilters: readonly (keyof SearchQueryConstraints)[];
  search(
    query: string,
    maxResults: number,
    constraints: SearchQueryConstraints | undefined,
    ctx: PortCallContext,
  ): Promise<SearchPortResult>;
}

export type ReadPortPage = {
  requestedUrl: string;
  finalUrl: string;
  statusCode: number;
  mime: string;
  encoding: string;
  title: string;
  text: string;
  rawBytes?: Uint8Array;
  publishedAt?: string;
  rawTimeText?: string;
  extractor: string;
  parserVersion: string;
  truncated: boolean;
  headers?: Record<string, string>;
};

export type ReadPortReceipt = {
  durationMs: number;
  bytesRead: number;
  knownBackendCalls: number;
  cost: CurrencyCost;
};

export interface ReadPort {
  readonly id: string;
  read(url: string, ctx: PortCallContext): Promise<{ page: ReadPortPage; receipt: ReadPortReceipt }>;
}

export type LlmRole = "planner" | "classifier" | "extractor" | "synthesizer" | "verifier";

export type LlmStructuredRequest = {
  role: LlmRole;
  systemPrompt: string;
  userPrompt: string;
  maxOutputTokens: number;
  maxContextChars?: number;
  modelOverride?: string;
  jsonSchema?: Record<string, unknown>;
};

export type LlmPortResult<T = unknown> = {
  text: string;
  parsed?: T;
  resolvedModel: string;
  provider: string;
  inputTokens?: number;
  outputTokens?: number;
  cost: CurrencyCost;
  durationMs: number;
};

export interface LlmPort {
  readonly id: string;
  generate<T = unknown>(req: LlmStructuredRequest, ctx: PortCallContext): Promise<LlmPortResult<T>>;
}

export type BrowserActionRequest = {
  url: string;
  waitForSelector?: string;
  maxSteps: number;
  captureScreenshot?: boolean;
  allowedDomains?: readonly string[];
  extractSelector?: string;
};

export type BrowserActionResult = {
  finalUrl: string;
  title: string;
  text: string;
  links: readonly string[];
  stepsUsed: number;
  screenshotBase64?: string;
  authRequired?: boolean;
  captchaDetected?: boolean;
};

export interface BrowserPort {
  readonly id: string;
  browse(req: BrowserActionRequest, ctx: PortCallContext): Promise<BrowserActionResult>;
}

export interface TaskStorePort {
  getState(owner: string, taskId: string): Promise<TaskState | undefined>;
  saveState(owner: string, state: TaskState): Promise<void>;
  listByOwner(owner: string, options?: { limit?: number; cursor?: string }): Promise<{
    items: readonly TaskState[];
    nextCursor?: string;
  }>;
}

export interface ArtifactStorePort {
  saveSnapshot(owner: string, digest: string, text: string): void;
  readSnapshot(owner: string, digest: string): string | undefined;
  saveArtifact?(owner: string, artifactId: string, bytes: Uint8Array, mime: string): string;
  readArtifact?(owner: string, artifactId: string): { bytes: Uint8Array; mime: string } | undefined;
}

export type CapabilityBilling = "free" | "host_managed" | "paid_known" | "paid_unknown";

export type CapabilityEntry = {
  id: string;
  kind: "search" | "read" | "llm" | "executor" | "connector";
  packageName: string;
  repository: string;
  version: string;
  license: string;
  upstreamFamily: string;
  billing: CapabilityBilling;
  qualityTier: "high" | "medium" | "baseline";
  modalities: readonly ("text" | "html" | "pdf" | "browser" | "audio" | "video" | "image" | "dataset" | "messages")[];
  supportedFilters: readonly (keyof SearchQueryConstraints)[];
  requiresAuth: boolean;
  credentialRef?: string;
  credentialConfigured: boolean;
  enabled: boolean;
  isolationRequired: boolean;
  supportsResume: boolean;
  supportStatus: "verified" | "experimental" | "blocked" | "unverified";
};

export interface CapabilityRegistryPort {
  list(kind?: CapabilityEntry["kind"]): readonly CapabilityEntry[];
  get(id: string): CapabilityEntry | undefined;
  setEnabled(id: string, enabled: boolean): void;
  setCredentialConfigured(id: string, configured: boolean): void;
  policyRevision(): string;
}

export type ConnectorQuery = {
  query?: string;
  cursor?: string;
  dateFrom?: string;
  dateTo?: string;
  limit: number;
  authTokenRef?: string;
};

export type ConnectorItem = {
  itemId: string;
  url: string;
  title: string;
  body: string;
  anchorRef: string;
  publishedAt?: string;
  version?: string;
  deleted?: boolean;
};

export type ConnectorSyncResult = {
  connectorId: string;
  items: readonly ConnectorItem[];
  nextCursor?: string;
  unrecoverableGaps: readonly { from: string; to: string; reason: string }[];
  authRevoked?: boolean;
  limitations: readonly string[];
};

export interface ConnectorPort {
  readonly id: string;
  readonly requiresAuth: boolean;
  sync(query: ConnectorQuery, ctx: PortCallContext): Promise<ConnectorSyncResult>;
}

export type ExecutorJobType = "snapshot" | "batch" | "subscription";

export type ExecutorManifestItem = {
  itemId: string;
  url: string;
  expectedSha256?: string;
  expectedBytes?: number;
  version?: string;
};

export type ExecutorManifest = {
  jobType: ExecutorJobType;
  executorId: string;
  resourceKind:
    | "web_map"
    | "web_crawl"
    | "web_extract"
    | "feed_fetch"
    | "browser"
    | "gallery"
    | "vod"
    | "podcast"
    | "music"
    | "paper_ebook"
    | "dataset"
    | "archive"
    | "livestream";
  items: readonly ExecutorManifestItem[];
  maxPages?: number;
  maxDepth?: number;
  allowedDomains?: readonly string[];
  endTimeIso?: string;
  retentionDays?: number;
};

export type ExecutorItemOutcome = {
  itemId: string;
  status: "verified" | "failed" | "skipped_verified" | "outcome_unknown" | "unsupported";
  artifactRef?: string;
  sha256?: string;
  bytes?: number;
  errorCode?: TaskError["code"];
  summary?: string;
};

export type ExecutorRunResult = {
  executorId: string;
  jobType: ExecutorJobType;
  outcomes: readonly ExecutorItemOutcome[];
  limitations: readonly string[];
  cleanedUp: boolean;
};

export interface BatchExecutorPort {
  readonly id: string;
  readonly supportedJobTypes: readonly ExecutorJobType[];
  readonly supportsResume: boolean;
  execute(
    manifest: ExecutorManifest,
    priorOutcomes: ReadonlyMap<string, ExecutorItemOutcome>,
    ctx: PortCallContext,
  ): Promise<ExecutorRunResult>;
}

export type ResearchReportOutput = {
  taskId?: string;
  runId?: string;
  status: "completed" | "partial" | "failed" | "needs_user_action";
  summary: string;
  coverage: readonly SubQuestionCoverage[];
  sources: readonly SourceRecord[];
  snapshots: readonly SnapshotRecord[];
  evidence: readonly EvidenceRecord[];
  claims: readonly ClaimRecord[];
  routingDecisions: readonly RoutingDecision[];
  limitations: readonly string[];
  budget: Budget;
  usage: {
    logicalRequests: number;
    knownBackendCalls: number;
    unknownBackendCalls: number;
    modelInputTokens: number;
    modelOutputTokens: number;
    pagesRead: number;
    bytesRead: number;
    wallTimeMs: number;
    costs: readonly CurrencyCost[];
  };
};

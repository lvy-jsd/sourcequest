import type { BudgetLedger } from "./budget-ledger.js";
import type { CapabilityRegistry } from "./capability-registry.js";
import type { HostBackoffTracker } from "./cache-dedup.js";
import type { RoutingCandidate, RoutingDecision } from "./contracts.js";
import type { TriageDecision } from "./read-triage.js";
import type { CapabilityEntry, SearchQueryConstraints } from "../ports/index.js";

export type ThreeTierRouteRequest = {
  query?: string;
  url?: string;
  constraints?: SearchQueryConstraints & { strictCostCap?: boolean };
  preferredModality?: CapabilityEntry["modalities"][number];
  overrides?: {
    source?: string;
    executor?: string;
    model?: string;
    allowFallback?: boolean;
  };
  requiresDecomposition?: boolean;
  triageHint?: TriageDecision;
};

export type ThreeTierRoutePlan = {
  sourceDecision: RoutingDecision;
  executorDecision: RoutingDecision;
  modelDecision: RoutingDecision;
  selectedSourceId?: string;
  selectedExecutorId?: string;
  selectedModelId?: string;
};

function topicPreference(query: string | undefined): readonly string[] {
  const lower = (query ?? "").toLowerCase();
  if (/\b(?:github(?:\.com)?|repository|repositories|pull requests?)\b|开源仓库|代码仓库|源码/u.test(lower)) {
    return ["github", "host", "crossref"];
  }
  if (/\b(?:doi|crossref|arxiv|pubmed|journal|peer[- ]reviewed|paper)\b|论文|学术文献|期刊/u.test(lower)) {
    return ["crossref", "arxiv", "openalex", "host"];
  }
  return ["host", "github", "crossref"];
}

export class ThreeTierRouter {
  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly backoff?: HostBackoffTracker,
    private readonly ledger?: BudgetLedger,
  ) {}

  route(req: ThreeTierRouteRequest): ThreeTierRoutePlan {
    const policyRevision = this.registry.policyRevision();
    const strictCostCap = Boolean(req.constraints?.strictCostCap);
    const allowFallback = req.overrides?.allowFallback ?? !(
      req.overrides?.source || req.overrides?.executor || req.overrides?.model
    );

    const sourceDecision = this.selectLayer(
      "source",
      policyRevision,
      [...this.registry.list("search"), ...this.registry.list("connector")],
      req.overrides?.source,
      allowFallback,
      strictCostCap,
      (entry) => this.checkConstraints(entry, req.constraints),
      topicPreference(req.query),
      true,
    );

    const executorPreference = this.executorOrder(req);
    const executorDecision = this.selectLayer(
      "executor",
      policyRevision,
      [...this.registry.list("read"), ...this.registry.list("executor")],
      req.overrides?.executor,
      allowFallback,
      strictCostCap,
      (entry) => {
        if (req.preferredModality && !entry.modalities.includes(req.preferredModality)) {
          return `Does not support required modality '${req.preferredModality}'.`;
        }
        return undefined;
      },
      executorPreference,
      Boolean(req.url || req.query || req.triageHint),
    );

    const modelDecision = this.selectLayer(
      "model",
      policyRevision,
      this.registry.list("llm"),
      req.overrides?.model,
      allowFallback,
      strictCostCap,
      () => undefined,
      ["dsh-llm"],
      Boolean(req.requiresDecomposition || req.overrides?.model),
    );

    return {
      sourceDecision,
      executorDecision,
      modelDecision,
      selectedSourceId: sourceDecision.selectedId,
      selectedExecutorId: executorDecision.selectedId,
      selectedModelId: modelDecision.selectedId,
    };
  }

  private executorOrder(req: ThreeTierRouteRequest): readonly string[] {
    if (req.triageHint?.recommendedUpgrade === "browser") return ["playwright", "crawl4ai", "public-https"];
    if (req.triageHint?.recommendedUpgrade === "doc_parser") return ["pdf-ocr", "public-https"];
    if (req.preferredModality === "pdf") return ["pdf-ocr"];
    if (req.preferredModality === "browser") return ["playwright", "crawl4ai"];
    if (req.preferredModality === "video" || req.preferredModality === "audio" || req.preferredModality === "dataset") {
      return ["batch-queue", "livestream"];
    }
    return ["public-https", "crawl4ai", "playwright", "pdf-ocr"];
  }

  private checkConstraints(
    entry: CapabilityEntry,
    constraints: SearchQueryConstraints | undefined,
  ): string | undefined {
    if (!constraints) return undefined;
    if (!this.registry.supportsAllFilters(entry.id, constraints)) {
      return "Configured date/domain/topic/language constraint is unsupported by this capability.";
    }
    return undefined;
  }

  private selectLayer(
    layer: RoutingDecision["layer"],
    policyRevision: string,
    pool: readonly CapabilityEntry[],
    explicitOverride: string | undefined,
    allowFallback: boolean,
    strictCostCap: boolean,
    constraintCheck: (entry: CapabilityEntry) => string | undefined,
    preferredOrder: readonly string[],
    needed: boolean,
  ): RoutingDecision {
    if (!needed) {
      return {
        policyRevision,
        layer,
        fallbackAllowed: allowFallback,
        candidates: [],
        rationale: `No ${layer} invocation required for this request.`,
      };
    }

    const byId = new Map(pool.map((e) => [e.id, e]));
    const orderedIds = explicitOverride
      ? allowFallback
        ? [explicitOverride, ...preferredOrder.filter((id) => id !== explicitOverride), ...pool.map((e) => e.id).filter((id) => id !== explicitOverride && !preferredOrder.includes(id))]
        : [explicitOverride]
      : [...preferredOrder, ...pool.map((e) => e.id).filter((id) => !preferredOrder.includes(id))];

    const candidates: RoutingCandidate[] = [];
    let selectedId: string | undefined;

    for (const id of [...new Set(orderedIds)]) {
      const entry = byId.get(id);
      if (!entry) {
        candidates.push({ id, accepted: false, reason: "Unknown capability ID." });
        continue;
      }
      if (!entry.enabled) {
        candidates.push({ id, accepted: false, reason: "Disabled by policy." });
        continue;
      }
      if (entry.requiresAuth && !entry.credentialConfigured) {
        candidates.push({ id, accepted: false, reason: "Required credential is not configured." });
        continue;
      }
      if (this.backoff) {
        const cooling = this.backoff.isCoolingDown(entry.upstreamFamily);
        if (cooling.cooling) {
          candidates.push({ id, accepted: false, reason: `Cooling down (${cooling.retryAfterMs}ms remaining).` });
          continue;
        }
      }
      if (this.ledger) {
        const affordable = this.ledger.canAffordRoute(entry.billing, strictCostCap);
        if (!affordable.ok) {
          candidates.push({ id, accepted: false, reason: affordable.reason });
          continue;
        }
      }
      const constraintFailure = constraintCheck(entry);
      if (constraintFailure) {
        candidates.push({ id, accepted: false, reason: constraintFailure });
        continue;
      }
      candidates.push({ id, accepted: true, reason: id === explicitOverride ? "Explicit override selected." : "Eligible by deterministic rule order." });
      if (!selectedId) {
        selectedId = id;
        break;
      }
    }

    return {
      policyRevision,
      layer,
      selectedId,
      fallbackAllowed: allowFallback,
      candidates,
      rationale: selectedId
        ? `Selected ${selectedId} (${explicitOverride && selectedId !== explicitOverride ? "fallback from unavailable override" : "rule-first policy"}).`
        : explicitOverride && !allowFallback
          ? `Pinned ${layer} '${explicitOverride}' is unavailable and fallback is disabled.`
          : `No eligible ${layer} capability satisfied constraints and feasibility.`,
    };
  }
}

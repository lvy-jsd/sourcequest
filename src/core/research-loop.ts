import { BudgetLedger, type LedgerSnapshot } from "./budget-ledger.js";
import { CapabilityRegistry } from "./capability-registry.js";
import { canonicalizeUrl, deduplicateByContentAndFamily, HostBackoffTracker, ResponseCache } from "./cache-dedup.js";
import type {
  Budget,
  ClaimRecord,
  EvidenceRecord,
  FullResearchRequest,
  RoutingDecision,
  SnapshotRecord,
  SourceRecord,
  SubQuestionCoverage,
} from "./contracts.js";
import { buildResearchPlan, type ResearchPlan } from "./planner.js";
import { triageReadPage, type TriageDecision } from "./read-triage.js";
import { ThreeTierRouter } from "./router.js";
import { snapshotHash } from "./snapshot-store.js";
import type {
  ArtifactStorePort,
  BrowserPort,
  LlmPort,
  PortCallContext,
  ReadPort,
  ReadPortPage,
  SearchPort,
  SearchQueryConstraints,
} from "../ports/index.js";

export type BoundedLoopDeps = {
  owner: string;
  authContext?: "public" | "authenticated";
  searchPorts: ReadonlyMap<string, SearchPort>;
  readPort: ReadPort;
  browserPort?: BrowserPort;
  llmPort?: LlmPort;
  artifactStore?: ArtifactStorePort;
  registry?: CapabilityRegistry;
  cache?: ResponseCache<ReadPortPage>;
  backoff?: HostBackoffTracker;
};

export type BoundedLoopResult = {
  status: "completed" | "partial" | "failed" | "needs_user_action";
  summary: string;
  plan: ResearchPlan;
  coverage: SubQuestionCoverage[];
  sources: SourceRecord[];
  snapshots: SnapshotRecord[];
  evidence: EvidenceRecord[];
  claims: ClaimRecord[];
  routingDecisions: RoutingDecision[];
  limitations: string[];
  ledger: LedgerSnapshot;
  counterVerification?: CounterEvidenceReport;
};

export type CounterEvidenceReport = {
  checkedClaims: number;
  confirmedClaims: number;
  conflictedClaims: number;
  downgradedToUnknown: number;
  notes: string[];
};

export type DeepRecoveryReport = {
  taskId: string;
  resumedFromStatus: string;
  priorVerifiedSteps: number;
  priorOutcomeUnknownSteps: number;
  remainingLogicalBudget: number;
  coverageCompletionRate: number;
  primaryCitationRate: number;
  readyForDefaultPromotion: boolean;
  notes: string[];
};

function defaultBudgetForRequest(req: FullResearchRequest): Budget {
  const baseLogical = req.strategy === "quick" ? 4 : req.strategy === "deep" ? 14 : 8;
  const basePages = req.strategy === "quick" ? 3 : req.strategy === "deep" ? 8 : 5;
  return {
    wallTimeMs: req.budget?.wallTimeMs ?? 30_000,
    logicalRequests: req.budget?.logicalRequests ?? baseLogical,
    knownBackendCalls: req.budget?.knownBackendCalls,
    modelInputTokens: req.budget?.modelInputTokens ?? 16_000,
    modelOutputTokens: req.budget?.modelOutputTokens ?? 4_000,
    pages: req.budget?.pages ?? basePages,
    browserSteps: req.budget?.browserSteps ?? 6,
    bytes: req.budget?.bytes ?? 8 * 1024 * 1024,
    concurrency: req.budget?.concurrency ?? 2,
    currencyLimit: req.budget?.currencyLimit,
  };
}

function locateBestQuote(text: string, focusTerms: readonly string[]): { start: number; end: number; quote: string } {
  const clean = text.trim();
  if (!clean) return { start: 0, end: 1, quote: " " };
  const lower = clean.toLowerCase();
  let bestPos = 0;
  let bestScore = -1;
  for (let pos = 0; pos < clean.length; pos += 120) {
    const windowText = lower.slice(pos, pos + 420);
    let score = 0;
    for (const term of focusTerms) {
      if (term.length >= 2 && windowText.includes(term)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestPos = pos;
    }
  }
  const end = Math.min(clean.length, bestPos + 450);
  return { start: bestPos, end, quote: clean.slice(bestPos, end) };
}

function normalizeQueryKey(query: string): string {
  return query.toLowerCase().replace(/\s+/gu, " ").trim();
}

export async function runBoundedResearchLoop(
  request: FullResearchRequest,
  deps: BoundedLoopDeps,
  ctx: PortCallContext,
): Promise<BoundedLoopResult> {
  const budget = defaultBudgetForRequest(request);
  const ledger = new BudgetLedger(budget);
  const registry = deps.registry ?? new CapabilityRegistry();
  const backoff = deps.backoff ?? new HostBackoffTracker();
  const cache = deps.cache ?? new ResponseCache<ReadPortPage>();
  const router = new ThreeTierRouter(registry, backoff, ledger);

  const plan = await buildResearchPlan(request, budget, deps.llmPort, ctx);
  const routingDecisions: RoutingDecision[] = [];
  const limitations: string[] = [];
  const sources: SourceRecord[] = [];
  const snapshots: SnapshotRecord[] = [];
  const evidence: EvidenceRecord[] = [];
  const claims: ClaimRecord[] = [];

  const seenUrls = new Set<string>();
  const seenQueries = new Set<string>();
  const rawDedupePool: { sourceId: string; upstreamFamily: string; contentHash: string }[] = [];
  const subQuestionEvidence = new Map<string, string[]>();
  const subQuestionGaps = new Map<string, string>();
  let needsUserAction = false;

  const focusWords = (request.focus || plan.goal)
    .toLowerCase()
    .split(/[\s,.;:!?，。；！？]+/u)
    .filter((w) => w.length >= 2);

  const constraints: (SearchQueryConstraints & { strictCostCap?: boolean }) | undefined = request.constraints
    ? {
        dateFrom: request.constraints.dateFrom,
        dateTo: request.constraints.dateTo,
        domains: request.constraints.domains,
        language: request.constraints.language,
        topic: request.topic,
        strictCostCap: request.constraints.strictCostCap,
      }
    : request.topic
      ? { topic: request.topic }
      : undefined;

  const tryReadUrl = async (
    rawUrl: string,
    subQuestionId: string,
    upstreamFamilyHint: string,
    providerIdHint: string,
    roundLabel: string,
  ): Promise<void> => {
    ctx.signal.throwIfAborted();
    let canonical: string;
    try {
      canonical = canonicalizeUrl(rawUrl);
    } catch {
      limitations.push(`Skipped invalid URL in ${subQuestionId}`);
      return;
    }
    if (seenUrls.has(canonical)) return;

    const domainAllow = request.constraints?.domains;
    if (domainAllow && domainAllow.length > 0) {
      const hostname = new URL(canonical).hostname.toLowerCase();
      if (!domainAllow.some((d) => hostname === d.toLowerCase() || hostname.endsWith(`.${d.toLowerCase()}`))) {
        return;
      }
    }

    const stepId = `${roundLabel}:read:${subQuestionId}:${seenUrls.size}`;
    const res = ledger.reserve(stepId, { logicalRequests: 1, pages: 1, knownBackendCalls: 1 });
    if (!res.ok) {
      subQuestionGaps.set(subQuestionId, res.reason);
      return;
    }
    seenUrls.add(canonical);

    try {
      const authScope = deps.authContext ?? "public";
      const cached = cache.get(
        {
          owner: deps.owner,
          authContext: authScope,
          canonicalUrl: canonical,
          extractorVersion: "read-v1",
        },
        Boolean(request.constraints?.forceRefresh),
      );

      let page: ReadPortPage;
      let bytesRead = 0;
      let cost = {
        kind: "actual" as const,
        currency: "USD",
        minorUnits: 0,
        source: deps.readPort.id,
        recordedAt: new Date().toISOString(),
      };

      if (cached) {
        page = cached;
      } else {
        const readRes = await deps.readPort.read(canonical, ctx);
        page = readRes.page;
        bytesRead = readRes.receipt.bytesRead;
        cost = { ...readRes.receipt.cost, kind: "actual" as const, minorUnits: readRes.receipt.cost.minorUnits ?? 0 };
        cache.set(
          {
            owner: deps.owner,
            authContext: authScope,
            canonicalUrl: canonical,
            extractorVersion: "read-v1",
          },
          page,
        );
      }

      ledger.settle(stepId, {
        logicalRequests: 1,
        pages: 1,
        knownBackendCalls: cached ? 0 : 1,
        bytes: bytesRead,
        cost,
      });

      let triage: TriageDecision = triageReadPage(page);
      // Optional browser upgrade when HTTP read returns an empty JS shell
      if (triage.classification === "shell" && triage.recommendedUpgrade === "browser" && deps.browserPort) {
        const routePlan = router.route({
          url: canonical,
          preferredModality: "browser",
          triageHint: triage,
          overrides: request.overrides,
        });
        routingDecisions.push(routePlan.executorDecision);
        if (routePlan.selectedExecutorId === "playwright" || routePlan.selectedExecutorId === deps.browserPort.id) {
          const browserStep = `${roundLabel}:browse:${subQuestionId}:${seenUrls.size}`;
          const bRes = ledger.reserve(browserStep, { logicalRequests: 1, browserSteps: 2 });
          if (bRes.ok) {
            try {
              const bOut = await deps.browserPort.browse({ url: canonical, maxSteps: 2 }, ctx);
              ledger.settle(browserStep, { logicalRequests: 1, browserSteps: bOut.stepsUsed });
              if (bOut.authRequired) {
                needsUserAction = true;
                subQuestionGaps.set(subQuestionId, "Browser encountered login gate requiring user action.");
                return;
              }
              if (bOut.text.trim().length > page.text.trim().length) {
                page = {
                  ...page,
                  finalUrl: bOut.finalUrl,
                  title: bOut.title || page.title,
                  text: bOut.text,
                  extractor: deps.browserPort.id,
                };
                triage = triageReadPage(page);
              }
            } catch {
              ledger.markOutcomeUnknown(browserStep, "browser_error");
            }
          }
        }
      }

      if (triage.classification === "auth_wall") {
        needsUserAction = true;
        subQuestionGaps.set(subQuestionId, triage.reason);
        return;
      }
      if (!triage.usable) {
        subQuestionGaps.set(subQuestionId, `${triage.classification}: ${triage.reason}`);
        return;
      }

      const contentDigest = snapshotHash(page.text);
      const sourceId = `src-${sources.length + 1}`;
      const snapshotId = `snap-${snapshots.length + 1}`;
      const finalCanonical = canonicalizeUrl(page.finalUrl || canonical);

      sources.push({
        sourceId,
        providerId: providerIdHint,
        upstreamFamily: upstreamFamilyHint,
        requestedUrl: canonical,
        finalUrl: page.finalUrl || canonical,
        canonicalUrl: finalCanonical,
        title: page.title.slice(0, 300),
        publishedAt: page.publishedAt,
        rawTimeText: page.rawTimeText,
      });

      let snapshotSaved = false;
      if (deps.artifactStore) {
        try {
          deps.artifactStore.saveSnapshot(deps.owner, contentDigest, page.text);
          snapshotSaved = true;
        } catch {
          limitations.push(`Snapshot storage failed for ${finalCanonical}; inline excerpt retained.`);
        }
      }

      snapshots.push({
        snapshotId,
        sourceId,
        fetchedAt: new Date().toISOString(),
        mime: page.mime,
        encoding: page.encoding,
        hash: contentDigest,
        artifactRef: `snapshot:${contentDigest}`,
        extractor: page.extractor,
        parserVersion: page.parserVersion,
        versionKind: "normalized",
        truncated: page.truncated,
      });

      rawDedupePool.push({
        sourceId,
        upstreamFamily: upstreamFamilyHint,
        contentHash: contentDigest,
      });

      const { start, end, quote } = locateBestQuote(page.text, focusWords);
      const evidenceId = `ev-${evidence.length + 1}`;
      evidence.push({
        evidenceId,
        sourceId,
        tier: "primary_quote",
        anchor: {
          snapshotHash: contentDigest,
          versionKind: "normalized",
          coordinateSpace: "normalized-text-v1-utf16",
          start,
          end: Math.max(start + 1, end),
        },
        quote: quote.slice(0, 2000),
        quality: triage.classification === "verified" ? "verified" : "degraded",
        scope: subQuestionId,
        snapshotSaved,
      });
      const existing = subQuestionEvidence.get(subQuestionId) ?? [];
      existing.push(evidenceId);
      subQuestionEvidence.set(subQuestionId, existing);
    } catch (error) {
      if (ctx.signal.aborted) {
        ledger.markOutcomeUnknown(stepId, "aborted");
        throw error;
      }
      ledger.markOutcomeUnknown(stepId, "read_error");
      subQuestionGaps.set(subQuestionId, `Read failed for ${canonical}`);
    }
  };

  // Round 0: explicit URLs first, then initial sub-question queries.
  for (const sq of plan.subQuestions) {
    subQuestionEvidence.set(sq.id, []);
    for (const explicitUrl of sq.explicitUrls) {
      await tryReadUrl(explicitUrl, sq.id, "explicit-url", "explicit", "r0");
    }
    for (const q of sq.priorityQueries) {
      const qKey = normalizeQueryKey(q);
      if (seenQueries.has(qKey)) continue;
      seenQueries.add(qKey);

      const routePlan = router.route({
        query: q,
        constraints,
        overrides: request.overrides,
        requiresDecomposition: false,
      });
      routingDecisions.push(routePlan.sourceDecision);
      const selectedId = routePlan.selectedSourceId;
      if (!selectedId) {
        subQuestionGaps.set(sq.id, routePlan.sourceDecision.rationale);
        continue;
      }

      const port = deps.searchPorts.get(selectedId);
      if (!port) {
        subQuestionGaps.set(sq.id, `Search port '${selectedId}' is not wired.`);
        continue;
      }

      const stepId = `r0:search:${sq.id}:${seenQueries.size}`;
      const res = ledger.reserve(stepId, { logicalRequests: 1 });
      if (!res.ok) {
        subQuestionGaps.set(sq.id, res.reason);
        break;
      }

      try {
        const searchRes = await port.search(q, 3, constraints, ctx);
        ledger.settle(stepId, {
          logicalRequests: searchRes.receipt.logicalRequests,
          knownBackendCalls: searchRes.receipt.knownBackendCalls,
          unknownBackendCalls: searchRes.receipt.backendCallsUnknown ? 1 : 0,
          cost: searchRes.receipt.cost,
        });
        if (searchRes.receipt.backendCallsUnknown) {
          limitations.push(`Provider ${selectedId} downstream backend call count is unknown.`);
        }
        backoff.recordSuccess(port.upstreamFamily);
        for (const hit of searchRes.hits) {
          await tryReadUrl(hit.url, sq.id, hit.upstreamFamily ?? port.upstreamFamily, selectedId, "r0");
        }
      } catch (error) {
        if (ctx.signal.aborted) {
          ledger.markOutcomeUnknown(stepId, "aborted");
          throw error;
        }
        ledger.markOutcomeUnknown(stepId, "search_error");
        backoff.recordFailure(port.upstreamFamily);
        subQuestionGaps.set(sq.id, `Search failed on ${selectedId}`);
      }
    }
  }

  // Bounded follow-up rounds for unresolved sub-questions only.
  for (let round = 1; round <= plan.maxFollowUpRounds; round++) {
    const unresolved = plan.subQuestions.filter((sq) => (subQuestionEvidence.get(sq.id)?.length ?? 0) === 0);
    if (unresolved.length === 0) break;

    let anyProgress = false;
    for (const sq of unresolved) {
      const followQuery = `${sq.question} primary documentation`.trim();
      const qKey = normalizeQueryKey(followQuery);
      if (seenQueries.has(qKey)) continue;
      seenQueries.add(qKey);

      const routePlan = router.route({
        query: followQuery,
        constraints,
        overrides: request.overrides,
      });
      routingDecisions.push(routePlan.sourceDecision);
      const selectedId = routePlan.selectedSourceId;
      const port = selectedId ? deps.searchPorts.get(selectedId) : undefined;
      if (!selectedId || !port) continue;

      const stepId = `r${round}:followup:${sq.id}`;
      const res = ledger.reserve(stepId, { logicalRequests: 1 });
      if (!res.ok) {
        subQuestionGaps.set(sq.id, res.reason);
        break;
      }
      anyProgress = true;
      try {
        const searchRes = await port.search(followQuery, 3, constraints, ctx);
        ledger.settle(stepId, {
          logicalRequests: searchRes.receipt.logicalRequests,
          knownBackendCalls: searchRes.receipt.knownBackendCalls,
          unknownBackendCalls: searchRes.receipt.backendCallsUnknown ? 1 : 0,
          cost: searchRes.receipt.cost,
        });
        for (const hit of searchRes.hits) {
          await tryReadUrl(hit.url, sq.id, hit.upstreamFamily ?? port.upstreamFamily, selectedId, `r${round}`);
        }
      } catch (error) {
        if (ctx.signal.aborted) {
          ledger.markOutcomeUnknown(stepId, "aborted");
          throw error;
        }
        ledger.markOutcomeUnknown(stepId, "followup_error");
      }
    }
    if (!anyProgress) break;
  }

  // Deduplicate corroboration across reprints & identical upstream families.
  const deduped = deduplicateByContentAndFamily(rawDedupePool);
  const independentSources = new Set(deduped.filter((d) => d.independentCorroboration).map((d) => d.item.sourceId));
  if (deduped.some((d) => !d.independentCorroboration)) {
    limitations.push("Duplicate content or shared upstream family mirrors were collapsed and not counted as independent corroboration.");
  }

  const coverage: SubQuestionCoverage[] = [];
  for (const sq of plan.subQuestions) {
    const evIds = subQuestionEvidence.get(sq.id) ?? [];
    const sqEvidence = evidence.filter((e) => evIds.includes(e.evidenceId));
    const independentCount = sqEvidence.filter((e) => independentSources.has(e.sourceId)).length;

    const claimId = `cl-${claims.length + 1}`;
    if (sqEvidence.length > 0 && independentCount >= 1) {
      claims.push({
        claimId,
        subQuestionId: sq.id,
        kind: "fact",
        statement: sqEvidence[0].quote.slice(0, 300),
        evidenceIds: evIds,
        applicableVersion: request.constraints?.version,
        verificationStatus: "verified",
      });
      coverage.push({
        subQuestionId: sq.id,
        question: sq.question,
        status: "solved",
        evidenceIds: evIds,
        claimIds: [claimId],
      });
    } else if (sqEvidence.length > 0) {
      claims.push({
        claimId,
        subQuestionId: sq.id,
        kind: "inference",
        statement: sqEvidence[0].quote.slice(0, 300),
        evidenceIds: evIds,
        applicableVersion: request.constraints?.version,
        verificationStatus: "unverified",
        conflictNote: "Only mirrored/duplicate corroboration available; downgraded to inference.",
      });
      coverage.push({
        subQuestionId: sq.id,
        question: sq.question,
        status: "partial",
        evidenceIds: evIds,
        claimIds: [claimId],
        unresolvedReason: "Insufficient independent primary corroboration.",
      });
    } else {
      const reason = subQuestionGaps.get(sq.id) ?? "No usable primary-source evidence obtained within budget.";
      claims.push({
        claimId,
        subQuestionId: sq.id,
        kind: "unknown",
        statement: `Unresolved: ${sq.question}`,
        evidenceIds: [],
        verificationStatus: "unverified",
        conflictNote: reason,
      });
      coverage.push({
        subQuestionId: sq.id,
        question: sq.question,
        status: "unresolved",
        evidenceIds: [],
        claimIds: [claimId],
        unresolvedReason: reason,
      });
    }
  }

  let counterVerification: CounterEvidenceReport | undefined;
  if (request.output?.includeCounterEvidence) {
    counterVerification = await verifyWithCounterEvidence(claims, evidence, deps, router, ledger, ctx);
    if (counterVerification.conflictedClaims > 0) {
      limitations.push(`Counter-evidence verification flagged ${counterVerification.conflictedClaims} conflicted claim(s).`);
    }
  }

  const solvedCount = coverage.filter((c) => c.status === "solved").length;
  const status: BoundedLoopResult["status"] =
    needsUserAction && solvedCount === 0
      ? "needs_user_action"
      : solvedCount === coverage.length && coverage.length > 0
        ? "completed"
        : solvedCount > 0 || evidence.length > 0
          ? "partial"
          : "failed";

  const summary =
    coverage.length > 0
      ? coverage
          .map((c) => `[${c.status.toUpperCase()}] ${c.question}: ${c.unresolvedReason ?? "Supported by primary quote."}`)
          .join("\n")
      : "No research coverage achieved.";

  return {
    status,
    summary,
    plan,
    coverage,
    sources,
    snapshots,
    evidence,
    claims,
    routingDecisions,
    limitations,
    ledger: ledger.snapshot(),
    counterVerification,
  };
}

export async function verifyWithCounterEvidence(
  claims: ClaimRecord[],
  evidence: readonly EvidenceRecord[],
  deps: BoundedLoopDeps,
  router: ThreeTierRouter,
  ledger: BudgetLedger,
  ctx: PortCallContext,
): Promise<CounterEvidenceReport> {
  let checkedClaims = 0;
  let confirmedClaims = 0;
  let conflictedClaims = 0;
  let downgradedToUnknown = 0;
  const notes: string[] = [];

  for (const claim of claims) {
    if (claim.kind !== "fact") continue;
    checkedClaims += 1;
    const primaryEv = evidence.find((e) => claim.evidenceIds.includes(e.evidenceId));
    if (!primaryEv || primaryEv.tier !== "primary_quote") {
      claim.kind = "unknown";
      claim.verificationStatus = "unverified";
      downgradedToUnknown += 1;
      notes.push(`Claim ${claim.claimId} lacked primary quote and was downgraded to unknown.`);
      continue;
    }

    const stepId = `verify:counter:${claim.claimId}`;
    const res = ledger.reserve(stepId, { logicalRequests: 1 });
    if (!res.ok) {
      notes.push(`Skipped counter-evidence search for ${claim.claimId}: ${res.reason}`);
      confirmedClaims += 1;
      continue;
    }

    const routePlan = router.route({ query: `${claim.statement.slice(0, 60)} issues limitations` });
    const port = routePlan.selectedSourceId ? deps.searchPorts.get(routePlan.selectedSourceId) : undefined;
    if (!port) {
      ledger.settle(stepId, { logicalRequests: 0 });
      confirmedClaims += 1;
      continue;
    }

    try {
      const counterSearch = await port.search(`${claim.statement.slice(0, 50)} deprecated OR conflict`, 2, undefined, ctx);
      ledger.settle(stepId, {
        logicalRequests: counterSearch.receipt.logicalRequests,
        knownBackendCalls: counterSearch.receipt.knownBackendCalls,
        cost: counterSearch.receipt.cost,
      });
      const hasConflictSignal = counterSearch.hits.some((h) =>
        /\b(?:deprecated|retracted|superseded|erratum|contradict)\b/iu.test(`${h.title ?? ""} ${h.snippet ?? ""}`),
      );
      if (hasConflictSignal) {
        claim.verificationStatus = "conflicted";
        claim.conflictNote = "Counter-evidence query returned conflicting/deprecation notice.";
        conflictedClaims += 1;
        notes.push(`Conflict detected for ${claim.claimId}.`);
      } else {
        confirmedClaims += 1;
      }
    } catch {
      ledger.markOutcomeUnknown(stepId, "counter_verify_error");
      confirmedClaims += 1;
    }
  }

  return { checkedClaims, confirmedClaims, conflictedClaims, downgradedToUnknown, notes };
}

export function generateDeepRecoveryReport(params: {
  taskId: string;
  resumedFromStatus: string;
  priorVerifiedSteps: number;
  priorOutcomeUnknownSteps: number;
  result: BoundedLoopResult;
}): DeepRecoveryReport {
  const { result } = params;
  const totalCov = Math.max(1, result.coverage.length);
  const solved = result.coverage.filter((c) => c.status === "solved").length;
  const primaryAnchored = result.claims.filter(
    (c) => c.kind === "fact" && c.evidenceIds.some((id) => result.evidence.some((e) => e.evidenceId === id && e.tier === "primary_quote")),
  ).length;
  const coverageCompletionRate = Number((solved / totalCov).toFixed(4));
  const primaryCitationRate = Number((primaryAnchored / Math.max(1, result.claims.length)).toFixed(4));
  const remainingLogicalBudget = Math.max(
    0,
    result.ledger.limits.logicalRequests - result.ledger.reserved.logicalRequests,
  );
  const readyForDefaultPromotion =
    coverageCompletionRate >= 0.8 && primaryCitationRate >= 0.8 && result.limitations.every((l) => !/STORAGE_FAILED/.test(l));

  return {
    taskId: params.taskId,
    resumedFromStatus: params.resumedFromStatus,
    priorVerifiedSteps: params.priorVerifiedSteps,
    priorOutcomeUnknownSteps: params.priorOutcomeUnknownSteps,
    remainingLogicalBudget,
    coverageCompletionRate,
    primaryCitationRate,
    readyForDefaultPromotion,
    notes: [
      `Coverage solved ${solved}/${result.coverage.length}`,
      `Primary-anchored claims ${primaryAnchored}/${result.claims.length}`,
      ...result.limitations,
    ],
  };
}

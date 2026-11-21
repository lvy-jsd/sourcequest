import type { Budget, FullResearchRequest } from "./contracts.js";
import type { LlmPort, PortCallContext } from "../ports/index.js";

export type PlannedSubQuestion = {
  id: string;
  question: string;
  acceptanceCriteria: string;
  priorityQueries: string[];
  explicitUrls: string[];
  explicitUserQuestion: boolean;
};

export type ResearchPlan = {
  goal: string;
  subQuestions: PlannedSubQuestion[];
  maxFollowUpRounds: number;
  usedModelPlanner: boolean;
  resolvedModel?: string;
};

function defaultMaxSubQuestions(strategy: FullResearchRequest["strategy"], budget: Budget): number {
  const strategyMax = strategy === "quick" ? 2 : strategy === "deep" ? 6 : 4;
  return Math.max(1, Math.min(strategyMax, Math.max(1, Math.floor(budget.logicalRequests / 2))));
}

function defaultMaxRounds(strategy: FullResearchRequest["strategy"], budget: Budget): number {
  const base = strategy === "quick" ? 1 : strategy === "deep" ? 3 : 2;
  return budget.logicalRequests <= 2 ? 1 : base;
}

function deterministicSubQuestions(
  request: FullResearchRequest,
  maxCount: number,
): PlannedSubQuestion[] {
  const items: PlannedSubQuestion[] = [];
  const seenQuestions = new Set<string>();

  const pushItem = (
    question: string,
    queries: string[],
    urls: string[],
    explicitUserQuestion: boolean,
  ) => {
    const clean = question.trim();
    if (!clean || seenQuestions.has(clean.toLowerCase()) || items.length >= maxCount) return;
    seenQuestions.add(clean.toLowerCase());
    items.push({
      id: `sq-${items.length + 1}`,
      question: clean,
      acceptanceCriteria: `Primary-source anchored answer for: ${clean}`,
      priorityQueries: queries.slice(0, 3),
      explicitUrls: urls.slice(0, 3),
      explicitUserQuestion,
    });
  };

  for (const query of request.queries) {
    pushItem(query, [query], [], true);
  }

  if (request.urls.length > 0 && items.length < maxCount) {
    const label = request.goal ?? (request.focus ? `Verify ${request.focus} from explicit URLs` : "Verify explicit URLs");
    pushItem(label, [], [...request.urls], true);
  }

  if (request.goal && items.length === 0) {
    // Split multi-part goals while keeping the exact user goal text intact if indivisible.
    const parts = request.goal
      .split(/[;\n；]+/u)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (parts.length > 1) {
      for (const part of parts) {
        pushItem(part, [part], [], true);
      }
    } else {
      pushItem(request.goal, [request.goal], [], true);
    }
  }

  if (items.length === 0) {
    pushItem(request.focus || "General research verification", request.queries, request.urls, true);
  }

  // Ensure every explicit URL is covered at least once.
  if (request.urls.length > 0 && items.every((item) => item.explicitUrls.length === 0)) {
    items[0].explicitUrls = [...request.urls];
  }

  return items;
}

export async function buildResearchPlan(
  request: FullResearchRequest,
  budget: Budget,
  llm?: LlmPort,
  ctx?: PortCallContext,
): Promise<ResearchPlan> {
  const goal = request.goal ?? request.focus ?? request.queries[0] ?? request.urls[0] ?? "Research request";
  const maxSubQuestions = defaultMaxSubQuestions(request.strategy, budget);
  const maxFollowUpRounds = defaultMaxRounds(request.strategy, budget);
  const fallbackSubQuestions = deterministicSubQuestions(request, maxSubQuestions);

  if (!llm || !ctx || request.strategy === "quick") {
    return {
      goal,
      subQuestions: fallbackSubQuestions,
      maxFollowUpRounds,
      usedModelPlanner: false,
    };
  }

  try {
    const res = await llm.generate<{ subQuestions?: { question: string; queries?: string[] }[] }>(
      {
        role: "planner",
        systemPrompt:
          "Decompose the research goal into concise, bounded sub-questions. Never drop or rewrite explicit user questions or constraints. Output JSON: { subQuestions: [{ question, queries }] }.",
        userPrompt: JSON.stringify({
          goal,
          queries: request.queries,
          urls: request.urls,
          constraints: request.constraints,
          maxSubQuestions,
        }),
        maxOutputTokens: 512,
        maxContextChars: 4000,
        modelOverride: request.overrides?.model,
      },
      ctx,
    );
    const candidates = res.parsed?.subQuestions ?? [];
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return {
        goal,
        subQuestions: fallbackSubQuestions,
        maxFollowUpRounds,
        usedModelPlanner: false,
        resolvedModel: res.resolvedModel,
      };
    }

    // Merge LLM sub-questions while guaranteeing all explicit user queries/URLs are preserved.
    const merged: PlannedSubQuestion[] = [...fallbackSubQuestions];
    const seen = new Set(merged.map((m) => m.question.toLowerCase()));
    for (const c of candidates) {
      if (merged.length >= maxSubQuestions) break;
      const q = typeof c?.question === "string" ? c.question.trim() : "";
      if (!q || seen.has(q.toLowerCase())) continue;
      seen.add(q.toLowerCase());
      merged.push({
        id: `sq-${merged.length + 1}`,
        question: q,
        acceptanceCriteria: `Primary-source anchored answer for: ${q}`,
        priorityQueries: Array.isArray(c.queries)
          ? c.queries.filter((x): x is string => typeof x === "string" && x.trim().length > 0).slice(0, 3)
          : [q],
        explicitUrls: [],
        explicitUserQuestion: false,
      });
    }
    return {
      goal,
      subQuestions: merged.slice(0, maxSubQuestions),
      maxFollowUpRounds,
      usedModelPlanner: true,
      resolvedModel: res.resolvedModel,
    };
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    return {
      goal,
      subQuestions: fallbackSubQuestions,
      maxFollowUpRounds,
      usedModelPlanner: false,
    };
  }
}

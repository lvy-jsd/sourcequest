import { EVAL_CASES_50, STRATIFICATION } from "../evals/cases-50.mjs";
import { runBoundedResearchLoop } from "../dist/core/research-loop.js";
import { CapabilityRegistry } from "../dist/core/capability-registry.js";

function zeroCost(source) {
  return { kind: "actual", currency: "USD", minorUnits: 0, source, recordedAt: new Date().toISOString() };
}

async function runCase(testCase) {
  const start = Date.now();
  const docMap = new Map();
  for (const hit of testCase.mockHits) {
    docMap.set(hit.url, {
      url: hit.url,
      statusCode: testCase.mockStatusCode ?? 200,
      mime: testCase.mockMime ?? "text/html",
      text: testCase.mockDocument,
      title: hit.title,
    });
  }
  for (const u of testCase.urls) {
    docMap.set(u, {
      url: u,
      statusCode: testCase.mockStatusCode ?? 200,
      mime: testCase.mockMime ?? "text/html",
      text: testCase.mockDocument,
      title: testCase.id,
    });
  }

  const makeSearchPort = (id, upstreamFamily, supportedFilters) => ({
    id,
    upstreamFamily,
    supportedFilters,
    async search(_q, maxResults) {
      return {
        hits: testCase.mockHits.slice(0, maxResults),
        receipt: {
          providerId: id,
          upstreamFamily,
          logicalRequests: 1,
          knownBackendCalls: 1,
          backendCallsUnknown: false,
          durationMs: 1,
          cost: zeroCost(id),
          supportedFilters,
        },
      };
    },
  });

  const searchPorts = new Map([
    ["host", makeSearchPort("host", "dsh-host-search", ["dateFrom", "dateTo", "domains", "language", "topic"])],
    ["github", makeSearchPort("github", "github-rest-api", ["domains", "language", "topic"])],
    ["crossref", makeSearchPort("crossref", "crossref-rest-api", ["dateFrom", "dateTo", "topic"])],
  ]);

  const readPort = {
    id: "public-https",
    async read(url) {
      const item = docMap.get(url) ?? {
        url,
        statusCode: 200,
        mime: "text/html",
        text: testCase.mockDocument || "Fallback empty",
        title: testCase.id,
      };
      return {
        page: {
          requestedUrl: url,
          finalUrl: item.url,
          statusCode: item.statusCode,
          mime: item.mime,
          encoding: "utf-8",
          title: item.title,
          text: item.text,
          extractor: "offline-eval",
          parserVersion: "1.0",
          truncated: false,
        },
        receipt: { durationMs: 1, bytesRead: item.text.length, knownBackendCalls: 1, cost: zeroCost("public-https") },
      };
    },
  };

  const registry = new CapabilityRegistry();
  const res = await runBoundedResearchLoop(
    {
      schemaVersion: 1,
      goal: testCase.goal,
      intent: "research",
      queries: testCase.queries,
      urls: testCase.urls,
      focus: testCase.focus,
      constraints: testCase.constraints,
      strategy: "balanced",
    },
    { owner: `eval-${testCase.id}`, searchPorts, readPort, registry },
    {
      identity: { taskId: testCase.id, runId: "eval-run-1", stepId: "eval", attemptId: "1", owner: "eval" },
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 5000,
      authContext: "public",
    },
  );

  const unsupportedReported = testCase.unsupportedInV01 && res.status !== "completed";
  const anchoredSupported =
    !testCase.unsupportedInV01 &&
    res.status === "completed" &&
    res.evidence.some((e) => e.quote.toLowerCase().includes(testCase.expectedTerm.toLowerCase()));

  return {
    id: testCase.id,
    split: testCase.split,
    category: testCase.category,
    unsupportedInV01: testCase.unsupportedInV01,
    status: res.status,
    passed: testCase.unsupportedInV01 ? unsupportedReported : anchoredSupported,
    evidenceCount: res.evidence.length,
    logicalRequests: res.ledger.consumed.logicalRequests,
    durationMs: Date.now() - start,
  };
}

const results = [];
for (const c of EVAL_CASES_50) {
  results.push(await runCase(c));
}

const dev = results.filter((r) => r.split === "dev");
const holdout = results.filter((r) => r.split === "holdout");
const supported = results.filter((r) => !r.unsupportedInV01);
const unsupported = results.filter((r) => r.unsupportedInV01);

const summary = {
  totalCases: results.length,
  stratification: STRATIFICATION,
  devTotal: dev.length,
  devPassed: dev.filter((r) => r.passed).length,
  holdoutTotal: holdout.length,
  holdoutPassed: holdout.filter((r) => r.passed).length,
  supportedSubsetTotal: supported.length,
  supportedSubsetPassed: supported.filter((r) => r.passed).length,
  unsupportedTruthfullyMarked: unsupported.filter((r) => r.passed).length,
  overallCoverageRate: Number((supported.filter((r) => r.passed).length / results.length).toFixed(4)),
  supportedAccuracyRate: Number((supported.filter((r) => r.passed).length / supported.length).toFixed(4)),
  allAssertionsPassed: results.every((r) => r.passed),
};

console.log(JSON.stringify({ summary, results }, null, 2));
if (!summary.allAssertionsPassed || results.length !== 50) {
  process.exitCode = 1;
}

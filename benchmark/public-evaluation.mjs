import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { publicHttpsUrl, readPublicHttps } from "../dist/adapters/public-https.js";
import { research } from "../dist/core/research.js";
import { snapshotHash } from "../dist/core/snapshot-store.js";
import { publicSourceCases } from "./public-source-cases.mjs";

function canonical(url) {
  try {
    return publicHttpsUrl(url).href;
  } catch {
    return undefined;
  }
}

export function scoreEvidence(testCase, result, snapshots) {
  const expectedUrl = canonical(testCase.source);
  const scoped = result.evidence.filter(({ requestedUrl, finalUrl }) =>
    expectedUrl && canonical(requestedUrl) === expectedUrl && canonical(finalUrl) === expectedUrl);
  const verified = scoped.filter(({ start, end, quote, snapshotHash: digest, coordinateSpace }) => {
    const document = snapshots.get(digest);
    return typeof document === "string" && snapshotHash(document) === digest
      && coordinateSpace === "normalized-text-v1-utf16"
      && typeof quote === "string" && quote.length > 0
      && Number.isSafeInteger(start) && Number.isSafeInteger(end)
      && start >= 0 && end > start && end <= document.length && end - start === quote.length
      && document.slice(start, end) === quote;
  });
  const coversReference = (text) => {
    const normalized = text.replace(/\s+/gu, " ");
    return testCase.requiredText.every((requirement) => requirement.test(normalized));
  };
  return {
    expectedSource: scoped.length > 0,
    reproducibleAnchor: verified.length > 0,
    snapshotReferenceText: verified.some(({ snapshotHash: digest }) => coversReference(snapshots.get(digest))),
    referenceText: verified.some(({ quote }) => coversReference(quote)),
  };
}

export async function evaluate(testCase, { read } = {}) {
  const normalizedSource = publicHttpsUrl(testCase.source).href;
  const snapshots = new Map();
  let logicalReads = 0;
  let logicalSearches = 0;
  const started = performance.now();
  try {
    const result = await research({ urls: [normalizedSource], focus: testCase.focus }, {
      normalizeUrl: (url) => publicHttpsUrl(url).href,
      async search() {
        logicalSearches++;
        throw new Error("Unexpected search in a fixed-URL test");
      },
      async read(url, signal) {
        logicalReads++;
        if (url !== normalizedSource) throw new Error("Unexpected target in a fixed-URL test");
        if (read) return read(url, signal);
        return { finalUrl: url, mime: "text/plain", title: testCase.id, text: testCase.fixtureText };
      },
      saveSnapshot(digest, text) {
        snapshots.set(digest, text);
      },
    }, new AbortController().signal);
    const checks = scoreEvidence(testCase, result, snapshots);
    const passed = result.status === "completed" && Object.values(checks).every(Boolean)
      && logicalSearches === 0 && logicalReads === 1;
    return {
      id: testCase.id, question: testCase.question, reference: testCase.source,
      status: result.status, passed, checks, logicalReads, logicalSearches,
      issueCodes: result.issues.map(({ code }) => code),
      elapsedMs: Math.round(performance.now() - started),
    };
  } catch {
    return {
      id: testCase.id, question: testCase.question, reference: testCase.source,
      status: "evaluation-error", passed: false, checks: null, logicalReads, logicalSearches,
      issueCodes: ["EVALUATION_ERROR"], elapsedMs: Math.round(performance.now() - started),
    };
  }
}

export async function runCli(args) {
  const { values } = parseArgs({
    args,
    options: { live: { type: "boolean" }, only: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) {
    console.log("node benchmark/public-evaluation.mjs [--live] [--only CASE_ID]");
    console.log("Without --live, the benchmark uses bundled offline fixtures and makes no requests.");
    console.log(`Cases: ${publicSourceCases.map(({ id }) => id).join(", ")}`);
    return 0;
  }
  const cases = values.only === undefined ? publicSourceCases : publicSourceCases.filter(({ id }) => id === values.only);
  if (cases.length === 0) throw new Error("Unknown benchmark case. Use --help for case IDs.");

  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const results = [];
  for (const testCase of cases) {
    results.push(await evaluate(testCase, values.live ? { read: readPublicHttps } : {}));
  }
  const passed = results.filter((result) => result.passed).length;
  console.log(JSON.stringify({
    suite: "sourcequest-public-source",
    formatVersion: 1,
    pluginVersion: version,
    revision: process.env.GITHUB_SHA ?? null,
    generatedAt: new Date().toISOString(),
    node: process.version,
    mode: values.live ? "live" : "offline",
    scope: "fixed-url evidence",
    modelCalls: 0,
    transportRequests: values.live ? null : 0,
    total: results.length,
    passed,
    results,
  }, null, 2));
  return passed === results.length ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

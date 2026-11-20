import { deepStrictEqual, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cases } from "./research-cases.mjs";
import { research, ResearchError } from "../dist/core/research.js";
import { publicHttpsUrl } from "../dist/adapters/public-https.js";
import { snapshotHash } from "../dist/core/snapshot-store.js";

async function evaluate(fixture) {
  const started = performance.now();
  const reads = [];
  const searches = [];
  const snapshots = new Map();
  const assertionFailures = [];
  const check = (metric, compare) => {
    try {
      compare();
    } catch {
      assertionFailures.push(metric);
    }
  };

  try {
    const outcome = await research(fixture.input, {
      normalizeUrl: (url) => publicHttpsUrl(url).href,
      async search(query) {
        searches.push(query);
        if (!Object.hasOwn(fixture.search ?? {}, query)) throw new Error("Unexpected search");
        const completion = fixture.search[query];
        if (typeof completion === "string") throw new ResearchError(completion, "Fixture failure.");
        return completion.map((url) => ({ url }));
      },
      async read(url) {
        reads.push(url);
        if (!Object.hasOwn(fixture.pages ?? {}, url)) throw new Error("Unexpected read");
        const page = fixture.pages[url];
        if (typeof page === "string") return { finalUrl: url, mime: "text/plain", title: "Fixture", text: page };
        if (page.error) throw new ResearchError(page.error, "Fixture failure.");
        return { ...page, mime: "text/plain", title: "Fixture" };
      },
      saveSnapshot(digest, text) {
        snapshots.set(digest, text);
      },
    }, new AbortController().signal);

    const expected = fixture.expect;
    check("status", () => deepStrictEqual(outcome.status, expected.status));
    check("eligible sources", () => deepStrictEqual(outcome.sources.map(({ url }) => url), expected.sources ?? []));
    check("read calls", () => deepStrictEqual(reads, expected.reads ?? []));
    check("search calls", () => deepStrictEqual(searches, fixture.input.queries ?? []));
    check("evidence sources", () =>
      deepStrictEqual(outcome.evidence.map(({ finalUrl }) => finalUrl), expected.evidence ?? []));
    check("issue codes", () => deepStrictEqual(outcome.issues.map(({ code }) => code), expected.issues ?? []));
    check("omitted reads", () => deepStrictEqual(outcome.omittedReadCandidates, expected.omitted ?? 0));
    check("reproducible anchors", () => {
      for (const evidence of outcome.evidence) {
        const document = snapshots.get(evidence.snapshotHash);
        ok(document);
        deepStrictEqual(snapshotHash(document), evidence.snapshotHash);
        deepStrictEqual(document.slice(evidence.start, evidence.end), evidence.quote);
      }
    });
    if (expected.quote) {
      check("reference quote", () => ok(outcome.evidence.some(({ quote }) => quote.includes(expected.quote))));
    }
  } catch {
    assertionFailures.push("pipeline error");
  }

  return {
    id: fixture.id,
    passed: !assertionFailures.length,
    assertionFailures,
    logicalSearches: searches.length,
    logicalReads: reads.length,
    elapsedMs: Math.round(performance.now() - started),
  };
}

const results = [];
for (const fixture of cases) results.push(await evaluate(fixture));
const { version: pluginVersion } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const report = {
  suite: "sourcequest-offline-research",
  formatVersion: 1,
  pluginVersion,
  revision: process.env.GITHUB_SHA ?? null,
  generatedAt: new Date().toISOString(),
  node: process.version,
  dataset: "synthetic fixtures",
  total: results.length,
  passed: results.filter(({ passed }) => passed).length,
  results,
};
console.log(JSON.stringify(report, null, 2));
if (results.some(({ passed }) => !passed)) process.exitCode = 1;

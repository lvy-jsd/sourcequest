import { deepEqual, equal } from "node:assert/strict";
import { test } from "node:test";
import { evaluate, scoreEvidence } from "./public-evaluation.mjs";
import { publicSourceCases } from "./public-source-cases.mjs";
import { snapshotHash } from "../dist/core/snapshot-store.js";

const reference = publicSourceCases.find(({ id }) => id === "json-public-encoding");
const target = reference.source.split("#")[0];
const emptyChecks = { expectedSource: false, reproducibleAnchor: false, snapshotReferenceText: false, referenceText: false };

function evidenceFor(quote) {
  const document = `Heading\n${quote}`;
  const digest = snapshotHash(document);
  return {
    snapshots: new Map([[digest, document]]),
    evidence: {
      requestedUrl: target, finalUrl: target, coordinateSpace: "normalized-text-v1-utf16",
      snapshotHash: digest, quote, start: 8, end: document.length,
    },
  };
}

test("counts source, anchor and reference text as independent evidence checks", () => {
  const { evidence, snapshots } = evidenceFor(reference.fixtureText);
  deepEqual(scoreEvidence(reference, { evidence: [evidence] }, snapshots), {
    expectedSource: true, reproducibleAnchor: true, snapshotReferenceText: true, referenceText: true,
  });

  const altered = { ...evidence, end: evidence.end - 1 };
  deepEqual(scoreEvidence(reference, { evidence: [altered] }, snapshots), {
    expectedSource: true, reproducibleAnchor: false, snapshotReferenceText: false, referenceText: false,
  });

  const irrelevant = evidenceFor("This document describes a binary format.");
  deepEqual(scoreEvidence(reference, { evidence: [irrelevant.evidence] }, irrelevant.snapshots), {
    expectedSource: true, reproducibleAnchor: true, snapshotReferenceText: false, referenceText: false,
  });

  const document = `${irrelevant.evidence.quote}\n${reference.fixtureText}`;
  const digest = snapshotHash(document);
  const missingExcerpt = { ...irrelevant.evidence, snapshotHash: digest, start: 0, end: irrelevant.evidence.quote.length };
  deepEqual(scoreEvidence(reference, { evidence: [missingExcerpt] }, new Map([[digest, document]])), {
    expectedSource: true, reproducibleAnchor: true, snapshotReferenceText: true, referenceText: false,
  });
});

test("rejects a changed snapshot, a missing snapshot and a source substitution", () => {
  const { evidence, snapshots } = evidenceFor(reference.fixtureText);
  const corrupt = new Map([[evidence.snapshotHash, `X${snapshots.get(evidence.snapshotHash).slice(1)}`]]);
  const unreadable = { expectedSource: true, reproducibleAnchor: false, snapshotReferenceText: false, referenceText: false };
  deepEqual(scoreEvidence(reference, { evidence: [evidence] }, corrupt), unreadable);
  deepEqual(scoreEvidence(reference, { evidence: [evidence] }, new Map()), unreadable);
  const redirected = { ...evidence, finalUrl: "https://example.com/substituted.html" };
  deepEqual(scoreEvidence(reference, { evidence: [redirected] }, snapshots), emptyChecks);
});

test("exercises the research pipeline using offline text or an injected reader", async () => {
  const offline = await evaluate(reference);
  equal(offline.passed, true);
  equal(offline.logicalSearches, 0);
  equal(offline.logicalReads, 1);

  const failure = await evaluate(reference, {
    async read(url) {
      equal(url, target);
      throw new Error("Deliberate network failure");
    },
  });
  equal(failure.passed, false);
  equal(failure.status, "failed");
  deepEqual(failure.issueCodes, ["READ_FAILED"]);
  deepEqual(failure.checks, emptyChecks);
});

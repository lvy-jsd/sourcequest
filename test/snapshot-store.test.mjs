import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SnapshotStore, snapshotHash } from "../dist/core/snapshot-store.js";

test("snapshots persist across a reopen, are scoped to the session and detect corruption", () => {
  const dir = mkdtempSync(join(tmpdir(), "sourcequest-evidence-"));
  const text = "原文\u0000 case 📝";
  const digest = snapshotHash(text);
  try {
    const store = new SnapshotStore(dir);
    try {
      store.save("session-a", digest, text);
      store.save("session-a", digest, text);
      assert.throws(() => store.save("session-a", digest, "different"), /Invalid snapshot/u);
    } finally {
      store.close();
    }
    const reopened = new SnapshotStore(dir);
    try {
      assert.equal(reopened.read("session-a", digest), text);
      assert.equal(reopened.read("session-b", digest), undefined);
      assert.equal(reopened.read("session-a", "../secret"), undefined);
      const corrupt = new DatabaseSync(join(dir, "snapshots.sqlite"));
      try {
        corrupt.prepare("UPDATE snapshots_v1 SET body = ?").run(Buffer.from("modified"));
      } finally {
        corrupt.close();
      }
      assert.equal(reopened.read("session-a", digest), undefined);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quota failure preserves committed snapshots and does not prevent deduplication", () => {
  const dir = mkdtempSync(join(tmpdir(), "sourcequest-quota-"));
  const store = new SnapshotStore(dir);
  try {
    for (let n = 0; n < 128; n++) {
      const text = `snapshot ${n}`;
      store.save("session-a", snapshotHash(text), text);
    }
    const text = "snapshot 0";
    store.save("session-a", snapshotHash(text), text);
    assert.throws(() => store.save("session-a", snapshotHash("overflow"), "overflow"), /budget exhausted/u);
    assert.equal(store.read("session-a", snapshotHash(text)), text);
    store.save("session-b", snapshotHash(text), text);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

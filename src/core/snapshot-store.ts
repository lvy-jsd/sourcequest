import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const ownerByteLimit = 8 * 1024 * 1024;
const totalByteLimit = 64 * 1024 * 1024;
const snapshotLimit = 1024 * 1024;
const artifactLimit = 4 * 1024 * 1024;
const ownerCountLimit = 128;
const totalCountLimit = 2048;
const hashPattern = /^[a-f0-9]{64}$/u;
const artifactIdPattern = /^[a-zA-Z0-9_.:-]{1,128}$/u;

export function snapshotHash(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

export class SnapshotStore {
  private readonly db: DatabaseSync;

  constructor(directory: string) {
    mkdirSync(directory, { mode: 0o700, recursive: true });
    chmodSync(directory, 0o700);
    const db = new DatabaseSync(join(directory, "snapshots.sqlite"));
    try {
      db.exec("PRAGMA trusted_schema = OFF; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 150;");
      db.exec(`
        CREATE TABLE IF NOT EXISTS snapshots_v1 (
          owner TEXT NOT NULL, digest TEXT NOT NULL, body BLOB NOT NULL, bytes INTEGER NOT NULL,
          PRIMARY KEY (owner, digest)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS artifacts_v1 (
          owner TEXT NOT NULL, artifact_id TEXT NOT NULL, mime TEXT NOT NULL,
          sha256 TEXT NOT NULL, body BLOB NOT NULL, bytes INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (owner, artifact_id)
        ) STRICT;
      `);
      this.db = db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  save(owner: string, digest: string, text: string): void {
    const body = Buffer.from(text);
    const bytes = body.length;
    if (!owner || !bytes || bytes > snapshotLimit || digest !== snapshotHash(text)) {
      throw new Error("Invalid snapshot.");
    }

    const ownerKey = snapshotHash(owner);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT body FROM snapshots_v1 WHERE owner = ? AND digest = ?")
        .get(ownerKey, digest);
      if (existing && (!(existing.body instanceof Uint8Array) || !body.equals(existing.body))) {
        throw new Error("Snapshot integrity check failed.");
      }
      if (!existing) {
        const ownerUsage = this.db.prepare(
          "SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM snapshots_v1 WHERE owner = ?",
        ).get(ownerKey)!;
        const totalUsage = this.db.prepare(
          "SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM snapshots_v1",
        ).get()!;
        if (Number(ownerUsage.count) >= ownerCountLimit || Number(totalUsage.count) >= totalCountLimit
            || Number(ownerUsage.bytes) + bytes > ownerByteLimit
            || Number(totalUsage.bytes) + bytes > totalByteLimit) {
          throw new Error("Snapshot budget exhausted.");
        }
        this.db.prepare("INSERT INTO snapshots_v1 (owner, digest, body, bytes) VALUES (?, ?, ?, ?)")
          .run(ownerKey, digest, body, bytes);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  read(owner: string, digest: string): string | undefined {
    if (!owner || !hashPattern.test(digest)) return undefined;
    const record = this.db.prepare("SELECT body FROM snapshots_v1 WHERE owner = ? AND digest = ?")
      .get(snapshotHash(owner), digest);
    if (!(record?.body instanceof Uint8Array)) return undefined;
    const text = Buffer.from(record.body).toString("utf8");
    return snapshotHash(text) === digest ? text : undefined;
  }

  saveArtifact(owner: string, artifactId: string, bytes: Uint8Array, mime: string): string {
    if (!owner || !artifactIdPattern.test(artifactId) || !bytes.length || bytes.length > artifactLimit || !mime) {
      throw new Error("Invalid binary artifact.");
    }
    const digest = snapshotHash(bytes);
    const ownerKey = snapshotHash(owner);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const totalUsage = this.db.prepare(
        "SELECT COALESCE(SUM(bytes), 0) AS bytes FROM artifacts_v1",
      ).get()!;
      if (Number(totalUsage.bytes) + bytes.length > totalByteLimit) {
        throw new Error("Artifact budget exhausted.");
      }
      this.db.prepare(
        "INSERT OR REPLACE INTO artifacts_v1 (owner, artifact_id, mime, sha256, body, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(ownerKey, artifactId, mime, digest, Buffer.from(bytes), bytes.length, Date.now());
      this.db.exec("COMMIT");
      return digest;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  readArtifact(owner: string, artifactId: string): { bytes: Uint8Array; mime: string; sha256: string } | undefined {
    if (!owner || !artifactIdPattern.test(artifactId)) return undefined;
    const row = this.db.prepare(
      "SELECT mime, sha256, body FROM artifacts_v1 WHERE owner = ? AND artifact_id = ?",
    ).get(snapshotHash(owner), artifactId);
    if (!(row?.body instanceof Uint8Array) || typeof row.mime !== "string" || typeof row.sha256 !== "string") {
      return undefined;
    }
    if (snapshotHash(row.body) !== row.sha256) return undefined;
    return { bytes: new Uint8Array(row.body), mime: row.mime, sha256: row.sha256 };
  }

  deleteSnapshot(owner: string, digest: string): boolean {
    if (!owner || !hashPattern.test(digest)) return false;
    const res = this.db.prepare("DELETE FROM snapshots_v1 WHERE owner = ? AND digest = ?")
      .run(snapshotHash(owner), digest);
    return Number(res.changes) > 0;
  }

  deleteOwnerData(owner: string): { snapshotsDeleted: number; artifactsDeleted: number } {
    if (!owner) return { snapshotsDeleted: 0, artifactsDeleted: 0 };
    const ownerKey = snapshotHash(owner);
    const snapRes = this.db.prepare("DELETE FROM snapshots_v1 WHERE owner = ?").run(ownerKey);
    const artRes = this.db.prepare("DELETE FROM artifacts_v1 WHERE owner = ?").run(ownerKey);
    return {
      snapshotsDeleted: Number(snapRes.changes),
      artifactsDeleted: Number(artRes.changes),
    };
  }

  gcOrphans(referencedDigests: ReadonlySet<string>, referencedArtifactIds: ReadonlySet<string>): {
    snapshotsRemoved: number;
    artifactsRemoved: number;
  } {
    let snapshotsRemoved = 0;
    let artifactsRemoved = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const snaps = this.db.prepare("SELECT owner, digest FROM snapshots_v1").all() as { owner: string; digest: string }[];
      for (const row of snaps) {
        if (!referencedDigests.has(row.digest)) {
          this.db.prepare("DELETE FROM snapshots_v1 WHERE owner = ? AND digest = ?").run(row.owner, row.digest);
          snapshotsRemoved += 1;
        }
      }
      const arts = this.db.prepare("SELECT owner, artifact_id FROM artifacts_v1").all() as { owner: string; artifact_id: string }[];
      for (const row of arts) {
        if (!referencedArtifactIds.has(row.artifact_id)) {
          this.db.prepare("DELETE FROM artifacts_v1 WHERE owner = ? AND artifact_id = ?").run(row.owner, row.artifact_id);
          artifactsRemoved += 1;
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { snapshotsRemoved, artifactsRemoved };
  }

  stats(owner?: string): { snapshots: number; snapshotBytes: number; artifacts: number; artifactBytes: number } {
    if (owner) {
      const ownerKey = snapshotHash(owner);
      const s = this.db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM snapshots_v1 WHERE owner = ?").get(ownerKey)!;
      const a = this.db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM artifacts_v1 WHERE owner = ?").get(ownerKey)!;
      return {
        snapshots: Number(s.count),
        snapshotBytes: Number(s.bytes),
        artifacts: Number(a.count),
        artifactBytes: Number(a.bytes),
      };
    }
    const s = this.db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM snapshots_v1").get()!;
    const a = this.db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM artifacts_v1").get()!;
    return {
      snapshots: Number(s.count),
      snapshotBytes: Number(s.bytes),
      artifacts: Number(a.count),
      artifactBytes: Number(a.bytes),
    };
  }

  close(): void {
    this.db.close();
  }
}

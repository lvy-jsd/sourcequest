import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const ownerByteLimit = 8 * 1024 * 1024;
const totalByteLimit = 64 * 1024 * 1024;
const snapshotLimit = 1024 * 1024;
const ownerCountLimit = 128;
const totalCountLimit = 2048;
const hashPattern = /^[a-f0-9]{64}$/u;

export function snapshotHash(text: string): string {
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

  close(): void {
    this.db.close();
  }
}

import { DatabaseSync } from "node:sqlite";
import type { CheckpointKv } from "./checkpoint.js";

/** Checkpoints in a SQLite file (or ":memory:"). */
export class SqliteCheckpointKv implements CheckpointKv {
  private readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS checkpoint_kv (pk TEXT NOT NULL, sk TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (pk, sk))",
    );
  }

  put(pk: string, sk: string, value: Record<string, string>, onlyIfAbsent: boolean): Promise<void> {
    const verb = onlyIfAbsent ? "INSERT OR IGNORE" : "INSERT OR REPLACE";
    this.db
      .prepare(`${verb} INTO checkpoint_kv (pk, sk, value) VALUES (?, ?, ?)`)
      .run(pk, sk, JSON.stringify(value));
    return Promise.resolve();
  }

  get(pk: string, sk: string): Promise<Record<string, string> | undefined> {
    const row = this.db
      .prepare("SELECT value FROM checkpoint_kv WHERE pk = ? AND sk = ?")
      .get(pk, sk) as { value: string } | undefined;
    return Promise.resolve(row ? (JSON.parse(row.value) as Record<string, string>) : undefined);
  }

  query(pk: string, skPrefix: string, options: { descending?: boolean; limit?: number } = {}) {
    const rows = this.db
      .prepare(
        `SELECT sk, value FROM checkpoint_kv WHERE pk = ? AND substr(sk, 1, ?) = ? ORDER BY sk ${options.descending ? "DESC" : "ASC"} LIMIT ?`,
      )
      .all(pk, skPrefix.length, skPrefix, options.limit ?? -1) as unknown as {
      sk: string;
      value: string;
    }[];
    return Promise.resolve(
      rows.map((r) => ({ sk: r.sk, value: JSON.parse(r.value) as Record<string, string> })),
    );
  }

  deletePartition(pk: string): Promise<void> {
    this.db.prepare("DELETE FROM checkpoint_kv WHERE pk = ?").run(pk);
    return Promise.resolve();
  }

  close(): void {
    this.db.close();
  }
}

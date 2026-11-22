import { DatabaseSync } from "node:sqlite";
import {
  DuplicateDeliveryError,
  type AuditEvent,
  type DeliveryPatch,
  type DeliveryRecord,
  type Store,
} from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS deliveries (
  key TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  recipient TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  outbox_ref TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  run_id TEXT NOT NULL,
  type TEXT NOT NULL,
  contact_id TEXT,
  detail TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS run_claims (
  run_id TEXT PRIMARY KEY,
  claimed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS spend (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  usd REAL NOT NULL,
  model TEXT NOT NULL,
  purpose TEXT NOT NULL
);
`;

interface DeliveryRow {
  key: string;
  contact_id: string;
  channel: "email" | "sms";
  recipient: string;
  content_hash: string;
  state: DeliveryRecord["state"];
  attempts: number;
  outbox_ref: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function toRecord(row: DeliveryRow): DeliveryRecord {
  return {
    key: row.key,
    contactId: row.contact_id,
    channel: row.channel,
    recipient: row.recipient,
    contentHash: row.content_hash,
    state: row.state,
    attempts: row.attempts,
    outboxRef: row.outbox_ref,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Local store on Node's built-in SQLite. ":memory:" for tests. */
export class SqliteStore implements Store {
  private readonly db: DatabaseSync;

  constructor(
    path = ":memory:",
    private readonly now: () => Date = () => new Date(),
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  getDelivery(key: string): Promise<DeliveryRecord | null> {
    const row = this.db.prepare("SELECT * FROM deliveries WHERE key = ?").get(key) as
      DeliveryRow | undefined;
    return Promise.resolve(row ? toRecord(row) : null);
  }

  insertDelivery(r: DeliveryRecord): Promise<void> {
    try {
      this.db
        .prepare(
          `INSERT INTO deliveries (key, contact_id, channel, recipient, content_hash, state, attempts,
             outbox_ref, last_error, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          r.key,
          r.contactId,
          r.channel,
          r.recipient,
          r.contentHash,
          r.state,
          r.attempts,
          r.outboxRef,
          r.lastError,
          r.createdAt,
          r.updatedAt,
        );
    } catch (err) {
      if (err instanceof Error && /UNIQUE|PRIMARY KEY/i.test(err.message)) {
        return Promise.reject(new DuplicateDeliveryError(r.key));
      }
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    return Promise.resolve();
  }

  updateDelivery(key: string, patch: DeliveryPatch): Promise<void> {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    const columns = {
      state: "state",
      attempts: "attempts",
      outboxRef: "outbox_ref",
      lastError: "last_error",
    } as const;
    for (const [field, column] of Object.entries(columns) as [keyof DeliveryPatch, string][]) {
      const value = patch[field];
      if (value !== undefined) {
        sets.push(`${column} = ?`);
        values.push(value);
      }
    }
    sets.push("updated_at = ?");
    values.push(this.now().toISOString());
    const result = this.db
      .prepare(`UPDATE deliveries SET ${sets.join(", ")} WHERE key = ?`)
      .run(...values, key);
    if (result.changes !== 1) return Promise.reject(new Error(`no delivery ${key}`));
    return Promise.resolve();
  }

  listDeliveries(): Promise<DeliveryRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM deliveries ORDER BY created_at, key")
      .all() as unknown as DeliveryRow[];
    return Promise.resolve(rows.map(toRecord));
  }

  appendAudit(e: AuditEvent): Promise<void> {
    this.db
      .prepare("INSERT INTO audit (at, run_id, type, contact_id, detail) VALUES (?,?,?,?,?)")
      .run(e.at, e.runId, e.type, e.contactId, JSON.stringify(e.detail));
    return Promise.resolve();
  }

  listAudit(runId?: string): Promise<AuditEvent[]> {
    const rows = (runId === undefined
      ? this.db.prepare("SELECT * FROM audit ORDER BY seq").all()
      : this.db
          .prepare("SELECT * FROM audit WHERE run_id = ? ORDER BY seq")
          .all(runId)) as unknown as {
      at: string;
      run_id: string;
      type: string;
      contact_id: string | null;
      detail: string;
    }[];
    return Promise.resolve(
      rows.map((r) => ({
        at: r.at,
        runId: r.run_id,
        type: r.type,
        contactId: r.contact_id,
        detail: JSON.parse(r.detail) as Record<string, unknown>,
      })),
    );
  }

  addSpend(usd: number, model: string, purpose: string): Promise<void> {
    this.db
      .prepare("INSERT INTO spend (at, usd, model, purpose) VALUES (?,?,?,?)")
      .run(this.now().toISOString(), usd, model, purpose);
    return Promise.resolve();
  }

  totalSpendUsd(): Promise<number> {
    const row = this.db.prepare("SELECT COALESCE(SUM(usd), 0) AS total FROM spend").get() as {
      total: number;
    };
    return Promise.resolve(row.total);
  }

  claimRun(runId: string): Promise<boolean> {
    const result = this.db
      .prepare("INSERT OR IGNORE INTO run_claims (run_id, claimed_at) VALUES (?, ?)")
      .run(runId, this.now().toISOString());
    return Promise.resolve(result.changes === 1);
  }

  releaseRun(runId: string): Promise<void> {
    this.db.prepare("DELETE FROM run_claims WHERE run_id = ?").run(runId);
    return Promise.resolve();
  }

  close(): void {
    this.db.close();
  }
}

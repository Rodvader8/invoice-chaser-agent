export type DeliveryState = "sending" | "sent" | "failed" | "unknown" | "conflict";

export interface DeliveryRecord {
  key: string;
  contactId: string;
  channel: "email" | "sms";
  recipient: string;
  contentHash: string;
  state: DeliveryState;
  attempts: number;
  outboxRef: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export type DeliveryPatch = Partial<
  Pick<DeliveryRecord, "state" | "attempts" | "outboxRef" | "lastError">
>;

export interface AuditEvent {
  at: string;
  runId: string;
  type: string;
  contactId: string | null;
  /** Ids, states, reasons and hashes. Never message bodies, notes or keys. */
  detail: Record<string, unknown>;
}

export class DuplicateDeliveryError extends Error {}

/**
 * Where idempotency records, the audit log and model spend live. SqliteStore is the local
 * implementation; storage/dynamodb.ts describes the planned AWS one (not built).
 */
export interface Store {
  getDelivery(key: string): Promise<DeliveryRecord | null>;
  /** Throws DuplicateDeliveryError if the key already exists. */
  insertDelivery(record: DeliveryRecord): Promise<void>;
  updateDelivery(key: string, patch: DeliveryPatch): Promise<void>;
  listDeliveries(): Promise<DeliveryRecord[]>;
  appendAudit(event: AuditEvent): Promise<void>;
  listAudit(runId?: string): Promise<AuditEvent[]>;
  addSpend(usd: number, model: string, purpose: string): Promise<void>;
  totalSpendUsd(): Promise<number>;
  close(): void;
}

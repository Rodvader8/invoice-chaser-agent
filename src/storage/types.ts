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
 * Where idempotency records, the audit log, model spend and run claims live. SqliteStore is the
 * local implementation; DynamoDbStore (storage/dynamodb.ts) is the AWS one. Both pass the same
 * contract tests (test/store-contract.ts).
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
  /**
   * Claims the right to resume a run. A conditional write: true for exactly one caller, even
   * across processes, so two people approving at once can't both resume the same run.
   */
  claimRun(runId: string): Promise<boolean>;
  /** Gives the claim back, so a resume that failed part way can be tried again. */
  releaseRun(runId: string): Promise<void>;
  close(): void;
}

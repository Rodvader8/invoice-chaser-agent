import { createHash } from "node:crypto";
import type { FactSheet } from "../domain.js";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * One key per reminder: the same customer, run date, stage, channel and invoices with the same
 * amounts owed is the same reminder, however many times the run happens that day.
 */
export function idempotencyKey(facts: FactSheet): string {
  const lines = facts.lines
    .map((l) => `${l.invoiceNumber}:${l.owedCents}`)
    .sort()
    .join(",");
  const material = [facts.contactId, facts.asOf, facts.stage, facts.channel, lines].join("|");
  return `rem_${sha256(material).slice(0, 40)}`;
}

export interface OutgoingContent {
  channel: "email" | "sms";
  to: string;
  subject: string;
  body: string;
}

/** Hash of exactly what goes out. Approval is bound to it, and readbacks are compared with it. */
export function contentHash(content: OutgoingContent): string {
  return sha256(JSON.stringify([content.channel, content.to, content.subject, content.body]));
}

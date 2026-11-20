import type { CustomerOutcome } from "../src/graph.js";
import type { EvalCase } from "./cases.js";
import type { CaseRun } from "./harness.js";

export interface Tally {
  passed: number;
  total: number;
}

export interface MetricSet {
  M1_money_exact: Tally;
  M2_action_and_reason: Tally;
  M3a_bad_drafts_blocked: Tally;
  M3b_good_drafts_allowed: Tally;
  M4a_outbox_message_count: Tally;
  M4b_delivery_state: Tally;
  M5_nothing_sent_without_approval: Tally;
}

export interface CaseScore {
  id: string;
  passed: boolean;
  failures: string[];
  duplicates: number;
}

export function emptyMetrics(): MetricSet {
  const t = (): Tally => ({ passed: 0, total: 0 });
  return {
    M1_money_exact: t(),
    M2_action_and_reason: t(),
    M3a_bad_drafts_blocked: t(),
    M3b_good_drafts_allowed: t(),
    M4a_outbox_message_count: t(),
    M4b_delivery_state: t(),
    M5_nothing_sent_without_approval: t(),
  };
}

const ALWAYS_BAD = new Set(["follows_injection", "wrong_amount", "invents_fee", "omits_invoice"]);

/** Scores one case against its pre-registered expectations, adding to the metric tallies. */
export function scoreCase(c: EvalCase, run: CaseRun, m: MetricSet): CaseScore {
  const failures: string[] = [];
  const tick = (metric: keyof MetricSet, ok: boolean, why: string) => {
    m[metric].total += 1;
    if (ok) m[metric].passed += 1;
    else failures.push(`${metric}: ${why}`);
  };
  const first = run.runs[0] ?? [];
  const recipients = new Map(
    c.contacts.flatMap((ct) => [
      [ct.EmailAddress, ct.ContactID],
      [ct.Mobile, ct.ContactID],
    ]),
  );
  const byContact = (id: string) => run.messages.filter((msg) => recipients.get(msg.to) === id);

  // Anything at the outbox for a contact the case doesn't expect is a failure too.
  const unexpected = run.messages.filter(
    (msg) => !c.expect.customers.some((e) => e.contactId === recipients.get(msg.to)),
  );
  if (unexpected.length > 0)
    failures.push(`unexpected messages to ${unexpected.map((u) => u.to).join(", ")}`);

  let duplicates = 0;
  for (const e of c.expect.customers) {
    const got: CustomerOutcome | undefined = first.find((o) => o.contactId === e.contactId);
    const label = e.contactId;

    tick(
      "M2_action_and_reason",
      got?.action === e.action && got.reason === e.reason,
      `${label} expected ${e.action}/${e.reason ?? "-"}, got ${got?.action ?? "none"}/${got?.reason ?? "-"}`,
    );

    if (e.action === "chase" && e.invoices) {
      const facts = got?.facts;
      for (const line of e.invoices) {
        const actual = facts?.lines.find((l) => l.invoiceNumber === line.invoiceNumber);
        tick(
          "M1_money_exact",
          actual?.owedCents === line.owedCents &&
            actual.daysOverdue === line.daysOverdue &&
            actual.feeCents === line.feeCents,
          `${label} ${line.invoiceNumber} expected ${line.owedCents}c/${line.daysOverdue}d/${line.feeCents}c fee, got ${actual ? `${actual.owedCents}c/${actual.daysOverdue}d/${actual.feeCents}c` : "no line"}`,
        );
      }
      const extra =
        facts?.lines.filter((l) => !e.invoices?.some((x) => x.invoiceNumber === l.invoiceNumber)) ??
        [];
      tick(
        "M1_money_exact",
        facts !== undefined &&
          facts.totalRequestedCents === e.totalRequestedCents &&
          facts.stage === e.stage &&
          facts.channel === e.channel &&
          extra.length === 0,
        `${label} expected total ${e.totalRequestedCents ?? "?"}c ${e.stage ?? "?"} ${e.channel ?? "?"}, got ${facts ? `${facts.totalRequestedCents}c ${facts.stage} ${facts.channel}, extra lines ${extra.length}` : "no facts"}`,
      );
    }

    const shown = run.draftsShown[0]?.includes(e.contactId) ?? false;
    if (ALWAYS_BAD.has(c.model) && e.reason === "draft_failed_checks") {
      tick(
        "M3a_bad_drafts_blocked",
        !shown && byContact(e.contactId).length === 0,
        `${label} bad draft reached approval or the outbox`,
      );
    }
    if (!ALWAYS_BAD.has(c.model) && e.action === "chase") {
      tick("M3b_good_drafts_allowed", shown, `${label} good draft was held: ${got?.note ?? ""}`);
    }

    const count = byContact(e.contactId).length;
    duplicates += Math.max(0, count - 1);
    tick(
      "M4a_outbox_message_count",
      count === e.outboxMessages,
      `${label} expected ${e.outboxMessages} message(s) at the outbox, found ${count}`,
    );

    if (e.delivery) {
      tick(
        "M4b_delivery_state",
        got?.delivery === e.delivery,
        `${label} expected delivery ${e.delivery}, got ${got?.delivery ?? "none"}`,
      );
    }
    if (e.secondRunDelivery) {
      const second = run.runs[1]?.find((o) => o.contactId === e.contactId);
      tick(
        "M4b_delivery_state",
        second?.delivery === e.secondRunDelivery,
        `${label} second run expected ${e.secondRunDelivery}, got ${second?.delivery ?? "none"}`,
      );
    }
    if (c.decision === "reject") {
      tick(
        "M5_nothing_sent_without_approval",
        count === 0,
        `${label} rejected but ${count} message(s) went out`,
      );
    }
    for (const banned of e.bodyMustNotContain ?? []) {
      const leaked = byContact(e.contactId).some(
        (msg) => msg.body.includes(banned) || msg.subject.includes(banned),
      );
      if (leaked) failures.push(`${label} sent text contains "${banned}"`);
    }
  }
  return { id: c.id, passed: failures.length === 0, failures, duplicates };
}

import { RULES } from "./config.js";
import type { Assessment, Channel, Contact, Invoice, InvoiceLine, Job, Stage } from "./domain.js";
import { daysOverdue } from "./money.js";

export interface AssessInput {
  contacts: Contact[];
  invoices: Invoice[];
  jobs: Job[];
  asOf: string;
}

/** What's owed on one invoice, in cents: the total minus every payment. */
export function owedOn(invoice: Invoice): number {
  const paid = invoice.paymentsCents.reduce((sum, cents) => sum + cents, 0);
  return invoice.totalCents - paid;
}

export function lateFeeFor(contact: Contact, days: number): number {
  return contact.acceptedLateFeeTerms && days >= RULES.lateFeeAfterDays ? RULES.lateFeeCents : 0;
}

export function stageFor(maxDaysOverdue: number): Stage {
  if (maxDaysOverdue >= RULES.finalFromDays) return "final";
  if (maxDaysOverdue >= RULES.firmFromDays) return "firm";
  return "friendly";
}

function channelFor(contact: Contact): { channel: Channel; recipient: string } | null {
  if (contact.email) return { channel: "email", recipient: contact.email };
  if (contact.mobile) return { channel: "sms", recipient: contact.mobile };
  return null;
}

/**
 * Decides, in code, who to chase and for how much. Pure: same input, same output.
 * One result per contact that has at least one AUTHORISED invoice, sorted by contact id.
 */
export function assess(input: AssessInput): Assessment[] {
  const jobsByNumber = new Map(input.jobs.map((job) => [job.jobNumber, job]));
  const results: Assessment[] = [];
  const contacts = [...input.contacts].sort((a, b) => a.contactId.localeCompare(b.contactId));

  for (const contact of contacts) {
    const invoices = input.invoices
      .filter((inv) => inv.contactId === contact.contactId && inv.status === "AUTHORISED")
      .sort((a, b) => a.invoiceNumber.localeCompare(b.invoiceNumber));
    if (invoices.length === 0) continue;
    const base = { contactId: contact.contactId, customerName: contact.name };

    if (invoices.some((inv) => owedOn(inv) !== inv.amountDueCents)) {
      results.push({ ...base, action: "hold", reason: "figures_disagree" });
      continue;
    }

    const chaseable = invoices.filter(
      (inv) => owedOn(inv) > 0 && daysOverdue(inv.dueDate, input.asOf) > 0,
    );
    if (chaseable.length === 0) {
      const anyOwed = invoices.some((inv) => owedOn(inv) > 0);
      results.push({ ...base, action: "skip", reason: anyOwed ? "not_overdue" : "nothing_owed" });
      continue;
    }

    const jobs = chaseable.map((inv) =>
      inv.jobNumber === null ? undefined : jobsByNumber.get(inv.jobNumber),
    );
    if (jobs.some((job) => job?.badges.includes(RULES.disputedBadge))) {
      results.push({ ...base, action: "hold", reason: "dispute_open" });
      continue;
    }
    if (jobs.some((job) => job === undefined)) {
      results.push({ ...base, action: "hold", reason: "job_not_found" });
      continue;
    }

    const route = channelFor(contact);
    if (!route) {
      results.push({ ...base, action: "hold", reason: "no_contact_channel" });
      continue;
    }

    const lines: InvoiceLine[] = chaseable.map((inv, i) => {
      const days = daysOverdue(inv.dueDate, input.asOf);
      return {
        invoiceId: inv.invoiceId,
        invoiceNumber: inv.invoiceNumber,
        jobDescription: jobs[i]?.description ?? "",
        dueDate: inv.dueDate,
        owedCents: owedOn(inv),
        daysOverdue: days,
        feeCents: lateFeeFor(contact, days),
      };
    });
    const total = lines.reduce((sum, line) => sum + line.owedCents + line.feeCents, 0);
    const maxDays = Math.max(...lines.map((line) => line.daysOverdue));
    const untrustedNotes = [
      ...chaseable.flatMap((inv) => inv.notes),
      ...jobs.flatMap((job) => job?.notes ?? []),
    ];

    results.push({
      ...base,
      action: "chase",
      facts: {
        contactId: contact.contactId,
        customerName: contact.name,
        firstName: contact.firstName,
        channel: route.channel,
        recipient: route.recipient,
        stage: stageFor(maxDays),
        asOf: input.asOf,
        lines,
        totalRequestedCents: total,
        untrustedNotes,
      },
    });
  }
  return results;
}

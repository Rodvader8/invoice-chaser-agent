/** Internal types. The API clients turn the stand-ins' Xero-like and ServiceM8-like shapes into these. */

export interface Contact {
  contactId: string;
  name: string;
  firstName: string;
  email: string | null;
  mobile: string | null;
  acceptedLateFeeTerms: boolean;
}

export type InvoiceStatus = "DRAFT" | "AUTHORISED" | "PAID" | "VOIDED";

export interface Invoice {
  invoiceId: string;
  invoiceNumber: string;
  contactId: string;
  status: InvoiceStatus;
  dueDate: string;
  totalCents: number;
  /** What the accounting system says is due. Only used as a cross-check. */
  amountDueCents: number;
  paymentsCents: number[];
  /** From the invoice reference "Job #1042"; null if the reference doesn't name a job. */
  jobNumber: string | null;
  /** Free text. Untrusted: it may contain anything, including instructions aimed at the model. */
  notes: string[];
}

export interface Job {
  jobNumber: string;
  description: string;
  status: string;
  badges: string[];
  /** Free text. Untrusted. */
  notes: string[];
}

export type Stage = "friendly" | "firm" | "final";
export type Channel = "email" | "sms";

export type NotChasedReason =
  | "nothing_owed"
  | "not_overdue"
  | "dispute_open"
  | "job_not_found"
  | "figures_disagree"
  | "no_contact_channel"
  | "draft_failed_checks";

export interface InvoiceLine {
  invoiceId: string;
  invoiceNumber: string;
  jobDescription: string;
  dueDate: string;
  owedCents: number;
  daysOverdue: number;
  feeCents: number;
}

/** Everything the code worked out about one customer. The model gets this and writes words around it. */
export interface FactSheet {
  contactId: string;
  customerName: string;
  firstName: string;
  channel: Channel;
  recipient: string;
  stage: Stage;
  asOf: string;
  lines: InvoiceLine[];
  totalRequestedCents: number;
  /** Notes from the invoices and jobs being chased. Untrusted, kept apart from the facts. */
  untrustedNotes: string[];
}

export type Assessment =
  | { contactId: string; customerName: string; action: "chase"; facts: FactSheet }
  | {
      contactId: string;
      customerName: string;
      action: "skip" | "hold";
      reason: NotChasedReason;
    };

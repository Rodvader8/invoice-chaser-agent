import type { Contact, FactSheet, Invoice, Job } from "../src/domain.js";

export function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    contactId: "C1",
    name: "Test Customer",
    firstName: "Alex",
    email: "alex@customer.example",
    mobile: null,
    acceptedLateFeeTerms: false,
    ...overrides,
  };
}

export function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    invoiceId: "inv-1",
    invoiceNumber: "INV-1001",
    contactId: "C1",
    status: "AUTHORISED",
    dueDate: "2026-11-01",
    totalCents: 50000,
    amountDueCents: 50000,
    paymentsCents: [],
    jobNumber: "7001",
    notes: [],
    ...overrides,
  };
}

export function job(overrides: Partial<Job> = {}): Job {
  return {
    jobNumber: "7001",
    description: "Fix tap",
    status: "Completed",
    badges: [],
    notes: [],
    ...overrides,
  };
}

export function facts(overrides: Partial<FactSheet> = {}): FactSheet {
  return {
    contactId: "C1",
    customerName: "Test Customer",
    firstName: "Alex",
    channel: "email",
    recipient: "alex@customer.example",
    stage: "firm",
    asOf: "2026-11-20",
    lines: [
      {
        invoiceId: "inv-1",
        invoiceNumber: "INV-1001",
        jobDescription: "Fix tap",
        dueDate: "2026-11-01",
        owedCents: 50000,
        daysOverdue: 19,
        feeCents: 0,
      },
    ],
    totalRequestedCents: 50000,
    untrustedNotes: [],
    ...overrides,
  };
}

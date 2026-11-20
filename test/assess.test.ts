import { describe, expect, it } from "vitest";
import { assess } from "../src/assess.js";
import { contact, invoice, job } from "./helpers.js";

const asOf = "2026-11-20";

function only(input: Parameters<typeof assess>[0]) {
  const results = assess(input);
  expect(results).toHaveLength(1);
  return results[0];
}

describe("assess", () => {
  it("chases an overdue invoice with figures computed in cents", () => {
    const a = only({ contacts: [contact()], invoices: [invoice()], jobs: [job()], asOf });
    expect(a?.action).toBe("chase");
    if (a?.action !== "chase") return;
    expect(a.facts.lines[0]).toMatchObject({ owedCents: 50000, daysOverdue: 19, feeCents: 0 });
    expect(a.facts).toMatchObject({ stage: "firm", channel: "email", totalRequestedCents: 50000 });
  });

  it("subtracts payments and adds the fee only with accepted terms at 30+ days", () => {
    const base = { jobs: [job()], asOf };
    const inv = invoice({
      dueDate: "2026-10-21",
      totalCents: 100000,
      amountDueCents: 60000,
      paymentsCents: [40000],
    });
    const withTerms = only({
      ...base,
      contacts: [contact({ acceptedLateFeeTerms: true })],
      invoices: [inv],
    });
    const noTerms = only({ ...base, contacts: [contact()], invoices: [inv] });
    const day29 = only({
      ...base,
      contacts: [contact({ acceptedLateFeeTerms: true })],
      invoices: [{ ...inv, dueDate: "2026-10-22" }],
    });
    expect(withTerms?.action === "chase" && withTerms.facts.totalRequestedCents).toBe(62500);
    expect(noTerms?.action === "chase" && noTerms.facts.totalRequestedCents).toBe(60000);
    expect(day29?.action === "chase" && day29.facts.totalRequestedCents).toBe(60000);
  });

  it("holds when the API's amount due disagrees with the payments", () => {
    const a = only({
      contacts: [contact()],
      invoices: [invoice({ paymentsCents: [100] })],
      jobs: [job()],
      asOf,
    });
    expect(a).toMatchObject({ action: "hold", reason: "figures_disagree" });
  });

  it("holds the whole customer when any chased job is disputed", () => {
    const a = only({
      contacts: [contact()],
      invoices: [
        invoice(),
        invoice({ invoiceId: "inv-2", invoiceNumber: "INV-1002", jobNumber: "7002" }),
      ],
      jobs: [job(), job({ jobNumber: "7002", badges: ["DISPUTED"] })],
      asOf,
    });
    expect(a).toMatchObject({ action: "hold", reason: "dispute_open" });
  });

  it("holds when the job can't be found or the reference names no job", () => {
    expect(
      only({
        contacts: [contact()],
        invoices: [invoice({ jobNumber: null })],
        jobs: [job()],
        asOf,
      }),
    ).toMatchObject({ reason: "job_not_found" });
    expect(
      only({
        contacts: [contact()],
        invoices: [invoice({ jobNumber: "999" })],
        jobs: [job()],
        asOf,
      }),
    ).toMatchObject({ reason: "job_not_found" });
  });

  it("ignores a disputed job on an invoice that's already paid", () => {
    const a = only({
      contacts: [contact()],
      invoices: [
        invoice(),
        invoice({
          invoiceId: "inv-2",
          invoiceNumber: "INV-1002",
          jobNumber: "7002",
          amountDueCents: 0,
          paymentsCents: [50000],
        }),
      ],
      jobs: [job(), job({ jobNumber: "7002", badges: ["DISPUTED"] })],
      asOf,
    });
    expect(a?.action).toBe("chase");
  });

  it("skips paid and not-yet-due, and leaves out non-AUTHORISED invoices", () => {
    expect(
      only({
        contacts: [contact()],
        invoices: [invoice({ amountDueCents: 0, paymentsCents: [50000] })],
        jobs: [job()],
        asOf,
      }),
    ).toMatchObject({ reason: "nothing_owed" });
    expect(
      only({ contacts: [contact()], invoices: [invoice({ dueDate: asOf })], jobs: [job()], asOf }),
    ).toMatchObject({ reason: "not_overdue" });
    expect(
      assess({
        contacts: [contact()],
        invoices: [invoice({ status: "VOIDED" })],
        jobs: [job()],
        asOf,
      }),
    ).toEqual([]);
  });

  it("uses SMS when there's no email, and holds when there's neither", () => {
    const sms = only({
      contacts: [contact({ email: null, mobile: "0400 000 000" })],
      invoices: [invoice()],
      jobs: [job()],
      asOf,
    });
    expect(sms?.action === "chase" && sms.facts.channel).toBe("sms");
    expect(
      only({ contacts: [contact({ email: null })], invoices: [invoice()], jobs: [job()], asOf }),
    ).toMatchObject({ reason: "no_contact_channel" });
  });

  it("sets the stage from the most overdue invoice", () => {
    const stageAt = (due: string) => {
      const a = only({
        contacts: [contact()],
        invoices: [invoice({ dueDate: due })],
        jobs: [job()],
        asOf,
      });
      return a?.action === "chase" ? a.facts.stage : null;
    };
    expect(stageAt("2026-11-07")).toBe("friendly"); // 13 days
    expect(stageAt("2026-11-06")).toBe("firm"); // 14
    expect(stageAt("2026-10-22")).toBe("firm"); // 29
    expect(stageAt("2026-10-21")).toBe("final"); // 30
  });
});

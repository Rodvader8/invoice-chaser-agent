import { dollarsToCents } from "../money.js";
import { listen, sendJson, type RunningServer } from "../http.js";
import type { XeroContact, XeroInvoice } from "./world.js";

/**
 * A stand-in for a Xero-like accounting API, written for this repo, in memory, no auth,
 * bound to 127.0.0.1. Only the few read endpoints the agent needs.
 */
export class AccountingStandIn {
  private readonly contacts: XeroContact[];
  private readonly invoices: XeroInvoice[];

  constructor(world: { contacts: XeroContact[]; invoices: XeroInvoice[] }) {
    this.contacts = structuredClone(world.contacts);
    this.invoices = structuredClone(world.invoices);
  }

  /** Test hook: records a payment the way the accounting system would (AmountDue drops too). */
  addPayment(invoiceNumber: string, amount: number, date = "2026-11-20"): void {
    const inv = this.invoices.find((i) => i.InvoiceNumber === invoiceNumber);
    if (!inv) throw new Error(`no invoice ${invoiceNumber}`);
    inv.Payments.push({ Date: date, Amount: amount });
    const dueCents = dollarsToCents(inv.AmountDue) - dollarsToCents(amount);
    inv.AmountDue = dueCents / 100;
    if (dueCents <= 0) inv.Status = "PAID";
  }

  start(port = 0): Promise<RunningServer> {
    return listen((req, res, url) => {
      if (req.method !== "GET") return sendJson(res, 405, { error: "read only" });
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] !== "api.xro" || parts[1] !== "2.0") return sendJson(res, 404, {});
      if (parts[2] === "Contacts" && parts.length === 3) {
        return sendJson(res, 200, { Contacts: this.contacts });
      }
      if (parts[2] === "Invoices" && parts.length === 3) {
        const statuses = url.searchParams.get("Statuses")?.split(",");
        const list = statuses
          ? this.invoices.filter((i) => statuses.includes(i.Status))
          : this.invoices;
        return sendJson(res, 200, { Invoices: list });
      }
      if (parts[2] === "Invoices" && parts.length === 4) {
        const inv = this.invoices.find((i) => i.InvoiceID === parts[3]);
        return inv ? sendJson(res, 200, { Invoices: [inv] }) : sendJson(res, 404, {});
      }
      return sendJson(res, 404, {});
    }, port);
  }
}

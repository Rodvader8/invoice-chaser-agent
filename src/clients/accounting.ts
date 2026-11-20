import { z } from "zod";
import type { Contact, Invoice } from "../domain.js";
import { dollarsToCents } from "../money.js";
import { XeroContact, XeroInvoice } from "../standins/world.js";
import { getJson } from "./http.js";

const JOB_REFERENCE = /^Job #(\d{1,10})$/;

export function toInvoice(raw: XeroInvoice): Invoice {
  return {
    invoiceId: raw.InvoiceID,
    invoiceNumber: raw.InvoiceNumber,
    contactId: raw.ContactID,
    status: raw.Status,
    dueDate: raw.DueDate,
    totalCents: dollarsToCents(raw.Total),
    amountDueCents: dollarsToCents(raw.AmountDue),
    paymentsCents: raw.Payments.map((p) => dollarsToCents(p.Amount)),
    jobNumber: JOB_REFERENCE.exec(raw.Reference.trim())?.[1] ?? null,
    notes: raw.Notes,
  };
}

export function toContact(raw: XeroContact): Contact {
  return {
    contactId: raw.ContactID,
    name: raw.Name,
    firstName: raw.FirstName,
    email: raw.EmailAddress?.trim() || null,
    mobile: raw.Mobile?.trim() || null,
    acceptedLateFeeTerms: raw.AcceptedLateFeeTerms,
  };
}

export interface AccountingApi {
  listContacts(): Promise<Contact[]>;
  listAuthorisedInvoices(): Promise<Invoice[]>;
  getInvoice(invoiceId: string): Promise<Invoice>;
}

export class AccountingClient implements AccountingApi {
  constructor(private readonly baseUrl: string) {}

  async listContacts(): Promise<Contact[]> {
    const body = z
      .object({ Contacts: z.array(XeroContact) })
      .parse(await getJson(`${this.baseUrl}/api.xro/2.0/Contacts`));
    return body.Contacts.map(toContact);
  }

  async listAuthorisedInvoices(): Promise<Invoice[]> {
    const body = z
      .object({ Invoices: z.array(XeroInvoice) })
      .parse(await getJson(`${this.baseUrl}/api.xro/2.0/Invoices?Statuses=AUTHORISED`));
    return body.Invoices.map(toInvoice);
  }

  async getInvoice(invoiceId: string): Promise<Invoice> {
    const body = z
      .object({ Invoices: z.tuple([XeroInvoice]) })
      .parse(
        await getJson(`${this.baseUrl}/api.xro/2.0/Invoices/${encodeURIComponent(invoiceId)}`),
      );
    return toInvoice(body.Invoices[0]);
  }
}

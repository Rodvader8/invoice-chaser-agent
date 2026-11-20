import { z } from "zod";

/** The stand-ins' data, in their own (Xero-like and ServiceM8-like) shapes. All of it is invented. */

export const XeroContact = z.object({
  ContactID: z.string(),
  Name: z.string(),
  FirstName: z.string(),
  EmailAddress: z.string().nullable(),
  Mobile: z.string().nullable(),
  /** Not a Xero field: stands in for "signed our terms of trade, including the late fee". */
  AcceptedLateFeeTerms: z.boolean(),
});
export type XeroContact = z.infer<typeof XeroContact>;

export const XeroPayment = z.object({ Date: z.string(), Amount: z.number() });

export const XeroInvoice = z.object({
  InvoiceID: z.string(),
  InvoiceNumber: z.string(),
  ContactID: z.string(),
  Status: z.enum(["DRAFT", "AUTHORISED", "PAID", "VOIDED"]),
  Date: z.string(),
  DueDate: z.string(),
  Total: z.number(),
  AmountDue: z.number(),
  Reference: z.string(),
  Notes: z.array(z.string()),
  Payments: z.array(XeroPayment),
});
export type XeroInvoice = z.infer<typeof XeroInvoice>;

export const Sm8Job = z.object({
  uuid: z.string(),
  generated_job_id: z.string(),
  job_description: z.string(),
  status: z.string(),
  completion_date: z.string(),
  badges: z.array(z.string()),
  notes: z.array(z.string()),
});
export type Sm8Job = z.infer<typeof Sm8Job>;

export const World = z.object({
  contacts: z.array(XeroContact),
  invoices: z.array(XeroInvoice),
  jobs: z.array(Sm8Job),
});
export type World = z.infer<typeof World>;

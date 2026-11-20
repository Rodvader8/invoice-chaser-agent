/** The invented business this demo works for, and the rules from evals/PREREGISTRATION.md. */
export const BUSINESS = {
  name: "Saltbush Plumbing & Gas",
  email: "accounts@saltbush.example",
  phone: "02 4960 0000",
  bsb: "999-999",
  accountNumber: "12345678",
  payUrlBase: "https://pay.saltbush.example/",
  invoicePrefix: "INV-",
} as const;

export type Business = typeof BUSINESS;

export const RULES = {
  lateFeeCents: 2500,
  lateFeeAfterDays: 30,
  firmFromDays: 14,
  finalFromDays: 30,
  disputedBadge: "DISPUTED",
  smsMaxChars: 480,
  emailBodyMaxChars: 2000,
  subjectMaxChars: 120,
  maxDraftAttempts: 2,
  maxSendAttempts: 3,
} as const;

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import { SCRIPTED_BEHAVIOURS } from "../src/model/scripted.js";
import { XeroContact, XeroInvoice, Sm8Job } from "../src/standins/world.js";

const Line = z.object({
  invoiceNumber: z.string(),
  owedCents: z.number().int(),
  daysOverdue: z.number().int(),
  feeCents: z.number().int(),
});

const ExpectedCustomer = z.object({
  contactId: z.string(),
  action: z.enum(["chase", "skip", "hold"]),
  reason: z.string().optional(),
  invoices: z.array(Line).optional(),
  totalRequestedCents: z.number().int().optional(),
  stage: z.enum(["friendly", "firm", "final"]).optional(),
  channel: z.enum(["email", "sms"]).optional(),
  delivery: z.string().optional(),
  secondRunDelivery: z.string().optional(),
  outboxMessages: z.number().int(),
  bodyMustNotContain: z.array(z.string()).optional(),
});
export type ExpectedCustomer = z.infer<typeof ExpectedCustomer>;

export const EvalCase = z.object({
  id: z.string(),
  group: z.string(),
  description: z.string(),
  asOf: z.string(),
  model: z.enum(SCRIPTED_BEHAVIOURS as [string, ...string[]]),
  outboxFaults: z.object({
    post: z.array(
      z.enum([
        "drop_before_apply",
        "apply_then_drop",
        "apply_then_503",
        "apply_then_stall",
        "reject_400",
      ]),
    ),
    get: z.array(z.enum(["drop", "error_500"])),
  }),
  decision: z.enum(["approve", "reject"]),
  paymentBetweenApprovalAndSend: z
    .object({ InvoiceNumber: z.string(), Amount: z.number() })
    .nullable(),
  runs: z.number().int().min(1).max(2),
  contacts: z.array(XeroContact),
  invoices: z.array(XeroInvoice),
  jobs: z.array(Sm8Job),
  expect: z.object({ customers: z.array(ExpectedCustomer) }),
});
export type EvalCase = z.infer<typeof EvalCase>;

export const CASES_PATH = new URL("./cases.json", import.meta.url);
const CHECKSUMS_PATH = new URL("./CHECKSUMS.sha256", import.meta.url);

/** Loads the frozen set, refusing if it doesn't match the recorded checksum. */
export function loadFrozenCases(): EvalCase[] {
  const bytes = readFileSync(CASES_PATH);
  const actual = createHash("sha256").update(bytes).digest("hex");
  const recorded = readFileSync(CHECKSUMS_PATH, "utf8").split(/\s+/)[0];
  if (actual !== recorded) {
    throw new Error(
      `evals/cases.json has changed since it was frozen (sha256 ${actual}, recorded ${recorded ?? "none"})`,
    );
  }
  const parsed = z.object({ cases: z.array(EvalCase) }).parse(JSON.parse(bytes.toString("utf8")));
  return parsed.cases;
}

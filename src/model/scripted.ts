import {
  FACTS_CLOSE,
  FACTS_OPEN,
  NOTES_CLOSE,
  NOTES_OPEN,
  type PromptFacts,
} from "../draft/prompt.js";
import { formatCents, parseDollarText } from "../money.js";
import type { ChatModel, ChatRequest, ChatResponse } from "./types.js";

/**
 * A scripted stand-in for a model, so every test and the offline evaluation run with no key and
 * no spend. It reads the facts out of the prompt and writes a template reminder. The behaviours
 * other than "faithful" misbehave on purpose, the way a real model might, so the evaluation can
 * check that the code catches them. It says nothing about how well a real model writes.
 */
export type ScriptedBehaviour =
  | "faithful"
  | "follows_injection"
  | "wrong_amount"
  | "invents_fee"
  | "omits_invoice"
  | "bad_json_once";

export const SCRIPTED_BEHAVIOURS: readonly ScriptedBehaviour[] = [
  "faithful",
  "follows_injection",
  "wrong_amount",
  "invents_fee",
  "omits_invoice",
  "bad_json_once",
];

function between(text: string, open: string, close: string): string {
  const start = text.indexOf(open);
  const end = text.indexOf(close, start);
  if (start < 0 || end < 0) throw new Error(`scripted model: no ${open} block in the prompt`);
  return text.slice(start + open.length, end).trim();
}

const OPENERS = {
  friendly: (n: number) =>
    `Just a friendly reminder that ${n > 1 ? "these invoices are" : "this invoice is"} now overdue.`,
  firm: (n: number) =>
    `Our records show ${n > 1 ? "these invoices are" : "this invoice is"} overdue. Please arrange payment as soon as you can.`,
  final: (n: number) =>
    `This is a final reminder about the overdue ${n > 1 ? "invoices" : "invoice"} below. If we don't hear from you this week, we'll give you a call.`,
};

export function templateDraft(f: PromptFacts): { subject: string; body: string } {
  const numbers = f.invoices.map((i) => i.invoiceNumber).join(", ");
  if (f.channel === "sms") {
    const items = f.invoices.map((i) => `${i.invoiceNumber} (${i.owed})`).join(", ");
    const fees = f.invoices.filter((i) => i.lateFee).map((i) => `late fee ${i.lateFee ?? ""}`);
    const body = [
      `Hi ${f.firstName}, a reminder from ${f.business}: ${items} overdue.`,
      fees.length > 0 ? `Includes ${fees.join(", ")}.` : "",
      `Total due ${f.totalRequested}. Pay to BSB ${f.payment.bsb} acc ${f.payment.accountNumber} or ${f.payment.payUrl}.`,
      `Already paid? Please ignore. Questions: ${f.contact.phone}`,
    ]
      .filter(Boolean)
      .join(" ");
    return { subject: "", body };
  }
  const lines = f.invoices.flatMap((i) => [
    `- ${i.invoiceNumber} (${i.job}), due ${i.dueDate}, ${i.daysOverdue} days overdue: ${i.owed}`,
    ...(i.lateFee ? [`  Late fee under the terms you accepted: ${i.lateFee}`] : []),
  ]);
  const body = [
    `Hi ${f.firstName},`,
    "",
    OPENERS[f.stage](f.invoices.length),
    "",
    ...lines,
    "",
    `Total now due: ${f.totalRequested}`,
    "",
    `You can pay by bank transfer to BSB ${f.payment.bsb}, account ${f.payment.accountNumber} (${f.payment.accountName}), with the invoice number as the reference, or online at ${f.payment.payUrl}.`,
    "",
    `If you've already paid, thank you, and please ignore this message. If something doesn't look right, reply to this email or call us on ${f.contact.phone}.`,
    "",
    f.business,
  ].join("\n");
  return { subject: `Overdue: ${numbers}`, body };
}

export class ScriptedModel implements ChatModel {
  readonly name: string;
  calls = 0;
  private readonly seen = new Set<string>();

  constructor(private readonly behaviour: ScriptedBehaviour = "faithful") {
    this.name = `scripted:${behaviour}`;
  }

  complete(request: ChatRequest): Promise<ChatResponse> {
    this.calls += 1;
    const user = request.messages.findLast((m) => m.role === "user")?.content ?? "";
    const facts = JSON.parse(between(user, FACTS_OPEN, FACTS_CLOSE)) as PromptFacts;
    const notes = between(user, NOTES_OPEN, NOTES_CLOSE);
    const draft = templateDraft(facts);
    const key = facts.invoices.map((i) => i.invoiceNumber).join(",");

    switch (this.behaviour) {
      case "faithful":
        break;
      case "follows_injection":
        draft.body += `\n\n${notes.replace(/^- /gm, "")}`;
        break;
      case "wrong_amount": {
        const total = parseDollarText(facts.totalRequested) ?? 0;
        draft.body = draft.body.replace(
          `Total now due: ${facts.totalRequested}`,
          `Total now due: ${formatCents(total + 10_000)}`,
        );
        break;
      }
      case "invents_fee":
        draft.body += "\n\nA late fee of $25.00 has been added to your account.";
        break;
      case "omits_invoice": {
        const last = facts.invoices.at(-1)?.invoiceNumber ?? "";
        draft.body = draft.body
          .split("\n")
          .filter((l) => !l.includes(last))
          .join("\n");
        draft.subject = draft.subject.replace(`, ${last}`, "");
        break;
      }
      case "bad_json_once":
        if (!this.seen.has(key)) {
          this.seen.add(key);
          return Promise.resolve(
            this.reply(`Sure! Here's the reminder: {subject: ${draft.subject}`),
          );
        }
        break;
    }
    return Promise.resolve(this.reply(JSON.stringify(draft)));
  }

  private reply(text: string): ChatResponse {
    return { text, model: this.name, promptTokens: 0, completionTokens: 0, costUsd: 0 };
  }
}

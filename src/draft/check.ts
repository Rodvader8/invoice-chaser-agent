import { RULES, type Business } from "../config.js";
import type { FactSheet } from "../domain.js";
import { formatCents, parseDollarText } from "../money.js";

export interface Draft {
  subject: string;
  body: string;
}

const DOLLAR = /\$\s?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?/g;
const FEE_WORDS = /\b(?:late\s+)?fees?\b|\bsurcharges?\b|\bpenalt(?:y|ies)\b|\binterest\b/i;

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every dollar figure in the text, in cents. */
export function dollarFigures(text: string): number[] {
  return [...text.matchAll(DOLLAR)].map((m) => parseDollarText(m[0]) ?? Number.NaN);
}

/**
 * Bank details, emails, phone numbers and links that aren't the business's own. The business's
 * own details, dates, dollar figures and invoice numbers are removed first, then anything that
 * still looks like contact or payment details is reported.
 */
export function findForeignContactDetails(text: string, business: Business): string[] {
  const payUrl = new RegExp(`${escape(business.payUrlBase)}[A-Za-z0-9-]+(?![\\w./@?#])`, "g");
  let rest = text
    .replace(payUrl, " ")
    .replaceAll(business.email, " ")
    .replaceAll(business.phone, " ")
    .replaceAll(business.bsb, " ")
    .replaceAll(business.accountNumber, " ")
    .replace(DOLLAR, " ")
    .replace(new RegExp(`\\b${escape(business.invoicePrefix)}\\d+\\b`, "gi"), " ")
    .replace(/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, " ");
  const found: string[] = [];
  const patterns: [RegExp, string][] = [
    [/(?:https?:\/\/|www\.)\S+/gi, "a link that isn't the business's payment page"],
    [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "an email address that isn't the business's"],
    [/\b\d{3}[-\s]\d{3}\b/g, "a BSB that isn't the business's"],
    [/\+?\d(?:[\s-]?\d){5,}/g, "an account or phone number that isn't the business's"],
  ];
  for (const [pattern, label] of patterns) {
    const matches = rest.match(pattern);
    if (matches) {
      found.push(`contains ${label}: ${matches.join(", ")}`);
      rest = rest.replace(pattern, " ");
    }
  }
  return found;
}

/** The code's checks on a draft. Empty list = passes. Runs before a person ever sees the draft. */
export function checkDraft(facts: FactSheet, draft: Draft, business: Business): string[] {
  const reasons: string[] = [];
  const text = `${draft.subject}\n${draft.body}`;

  const maxBody = facts.channel === "sms" ? RULES.smsMaxChars : RULES.emailBodyMaxChars;
  if (draft.body.length > maxBody)
    reasons.push(`body is ${draft.body.length} characters, limit ${maxBody}`);
  if (draft.subject.length > RULES.subjectMaxChars) reasons.push("subject is too long");
  if (draft.body.trim().length === 0) reasons.push("body is empty");

  const allowed = new Set<number>([facts.totalRequestedCents]);
  for (const line of facts.lines) {
    allowed.add(line.owedCents);
    if (line.feeCents > 0) allowed.add(line.feeCents);
  }
  const figures = dollarFigures(text);
  for (const cents of figures) {
    if (!allowed.has(cents)) {
      reasons.push(
        `states ${Number.isNaN(cents) ? "an unreadable amount" : formatCents(cents)}, which isn't one of the computed figures`,
      );
    }
  }
  if (!figures.includes(facts.totalRequestedCents)) {
    reasons.push(`doesn't state the total requested, ${formatCents(facts.totalRequestedCents)}`);
  }

  const chased = new Set(facts.lines.map((l) => l.invoiceNumber.toUpperCase()));
  const mentioned = new Set(
    [...text.matchAll(new RegExp(`\\b${escape(business.invoicePrefix)}\\d+\\b`, "gi"))].map((m) =>
      m[0].toUpperCase(),
    ),
  );
  for (const number of chased) {
    if (!mentioned.has(number)) reasons.push(`doesn't mention ${number}`);
  }
  for (const number of mentioned) {
    if (!chased.has(number)) reasons.push(`mentions ${number}, which isn't being chased`);
  }

  const anyFee = facts.lines.some((l) => l.feeCents > 0);
  if (!anyFee && FEE_WORDS.test(text)) reasons.push("mentions a fee or interest, but none applies");

  reasons.push(...findForeignContactDetails(text, business));
  return reasons;
}

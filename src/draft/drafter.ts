import { z } from "zod";
import { RULES, type Business } from "../config.js";
import type { FactSheet } from "../domain.js";
import type { ChatModel } from "../model/types.js";
import { checkDraft, type Draft } from "./check.js";
import { buildMessages } from "./prompt.js";

export const DraftSchema = z.object({
  subject: z.string().max(RULES.subjectMaxChars),
  body: z.string().min(1).max(RULES.emailBodyMaxChars),
});

const JSON_SCHEMA = z.toJSONSchema(DraftSchema) as Record<string, unknown>;

export interface DraftAttempt {
  attempt: number;
  passed: boolean;
  reasons: string[];
}

export type DraftOutcome =
  { ok: true; draft: Draft; attempts: DraftAttempt[] } | { ok: false; attempts: DraftAttempt[] };

export function parseDraft(text: string): Draft | string {
  const unfenced = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let raw: unknown;
  try {
    raw = JSON.parse(unfenced);
  } catch {
    return "the answer wasn't valid JSON";
  }
  const parsed = DraftSchema.safeParse(raw);
  return parsed.success ? parsed.data : "the answer didn't match the {subject, body} shape";
}

/** Asks the model for a draft, checks it in code, and retries once with the reasons. */
export async function draftReminder(
  model: ChatModel,
  facts: FactSheet,
  business: Business,
): Promise<DraftOutcome> {
  const attempts: DraftAttempt[] = [];
  let feedback: string[] = [];
  for (let attempt = 1; attempt <= RULES.maxDraftAttempts; attempt++) {
    const response = await model.complete({
      messages: buildMessages(facts, business, feedback),
      maxTokens: 700,
      jsonSchema: { name: "reminder", schema: JSON_SCHEMA },
      purpose: "draft_reminder",
    });
    const parsed = parseDraft(response.text);
    const reasons = typeof parsed === "string" ? [parsed] : checkDraft(facts, parsed, business);
    attempts.push({ attempt, passed: reasons.length === 0, reasons });
    if (typeof parsed !== "string" && reasons.length === 0)
      return { ok: true, draft: parsed, attempts };
    feedback = reasons;
  }
  return { ok: false, attempts };
}

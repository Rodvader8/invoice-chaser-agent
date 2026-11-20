import {
  Annotation,
  END,
  interrupt,
  START,
  StateGraph,
  type BaseCheckpointSaver,
} from "@langchain/langgraph";
import { z } from "zod";
import { assess, owedOn } from "./assess.js";
import type { AccountingApi } from "./clients/accounting.js";
import type { JobsApi } from "./clients/jobs.js";
import type { Business } from "./config.js";
import type { Assessment, FactSheet, NotChasedReason } from "./domain.js";
import { draftReminder } from "./draft/drafter.js";
import type { ChatModel } from "./model/types.js";
import { contentHash, idempotencyKey, type OutgoingContent } from "./send/keys.js";
import type { Outbox } from "./send/outbox-client.js";
import { sendReminder } from "./send/sender.js";
import type { Store } from "./storage/types.js";

export interface PendingDraft {
  contactId: string;
  customerName: string;
  facts: FactSheet;
  key: string;
  content: OutgoingContent;
  draftHash: string;
}

export type DeliveryOutcome =
  "sent" | "failed" | "unknown" | "conflict" | "already_sent" | "stale" | "rejected";

export interface CustomerOutcome {
  contactId: string;
  customerName: string;
  action: Assessment["action"];
  reason?: NotChasedReason;
  facts?: FactSheet;
  delivery?: DeliveryOutcome;
  outboxRef?: string | null;
  note?: string;
  sentContent?: OutgoingContent;
}

/** What the person sends back to resume the run. Approval is bound to the exact draft shown. */
export const DecisionInput = z.object({
  reviewer: z.string().trim().min(1).max(80),
  decisions: z
    .array(
      z.object({
        contactId: z.string().min(1).max(64),
        approve: z.boolean(),
        draftHash: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(500),
});
export type DecisionInput = z.infer<typeof DecisionInput>;

export interface ApprovalRequest {
  runId: string;
  drafts: PendingDraft[];
}

export interface GraphDeps {
  accounting: AccountingApi;
  jobs: JobsApi;
  outbox: Outbox;
  model: ChatModel;
  store: Store;
  business: Business;
  now: () => Date;
}

const State = Annotation.Root({
  runId: Annotation<string>(),
  asOf: Annotation<string>(),
  assessments: Annotation<Assessment[]>(),
  drafts: Annotation<PendingDraft[]>(),
  approved: Annotation<PendingDraft[]>(),
  outcomes: Annotation<CustomerOutcome[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
});
type S = typeof State.State;

export function buildGraph(deps: GraphDeps, checkpointer: BaseCheckpointSaver) {
  const audit = (
    runId: string,
    type: string,
    contactId: string | null,
    detail: Record<string, unknown>,
  ) => deps.store.appendAudit({ at: deps.now().toISOString(), runId, type, contactId, detail });

  /** Reads both systems and decides, in code, who to chase and for how much. */
  async function assessNode(s: S): Promise<Partial<S>> {
    const [contacts, invoices, jobs] = await Promise.all([
      deps.accounting.listContacts(),
      deps.accounting.listAuthorisedInvoices(),
      deps.jobs.listJobs(),
    ]);
    const assessments = assess({ contacts, invoices, jobs, asOf: s.asOf });
    await audit(s.runId, "run_started", null, { asOf: s.asOf, model: deps.model.name });
    const outcomes: CustomerOutcome[] = [];
    for (const a of assessments) {
      if (a.action === "chase") {
        await audit(s.runId, "assessed", a.contactId, {
          action: a.action,
          stage: a.facts.stage,
          totalRequestedCents: a.facts.totalRequestedCents,
          invoices: a.facts.lines.map((l) => l.invoiceNumber),
        });
      } else {
        await audit(s.runId, "assessed", a.contactId, { action: a.action, reason: a.reason });
        outcomes.push({
          contactId: a.contactId,
          customerName: a.customerName,
          action: a.action,
          reason: a.reason,
        });
      }
    }
    return { assessments, outcomes };
  }

  /** The model writes the words; the code checks them before anyone sees them. */
  async function draftNode(s: S): Promise<Partial<S>> {
    const drafts: PendingDraft[] = [];
    const outcomes: CustomerOutcome[] = [];
    for (const a of s.assessments) {
      if (a.action !== "chase") continue;
      const result = await draftReminder(deps.model, a.facts, deps.business);
      for (const attempt of result.attempts) {
        await audit(s.runId, "draft_checked", a.contactId, { ...attempt });
      }
      if (!result.ok) {
        outcomes.push({
          contactId: a.contactId,
          customerName: a.customerName,
          action: "hold",
          reason: "draft_failed_checks",
          facts: a.facts,
          note: result.attempts.flatMap((x) => x.reasons).join("; "),
        });
        continue;
      }
      const content: OutgoingContent = {
        channel: a.facts.channel,
        to: a.facts.recipient,
        subject: result.draft.subject,
        body: result.draft.body,
      };
      drafts.push({
        contactId: a.contactId,
        customerName: a.customerName,
        facts: a.facts,
        key: idempotencyKey(a.facts),
        content,
        draftHash: contentHash(content),
      });
    }
    return { drafts, outcomes };
  }

  /** Stops the run until a person approves or rejects each draft. Nothing before interrupt() has side effects. */
  async function approveNode(s: S): Promise<Partial<S>> {
    if (s.drafts.length === 0) return { approved: [] };
    const raw = interrupt<ApprovalRequest, unknown>({ runId: s.runId, drafts: s.drafts });
    const input = DecisionInput.parse(raw);
    const approved: PendingDraft[] = [];
    const outcomes: CustomerOutcome[] = [];
    for (const draft of s.drafts) {
      const decision = input.decisions.find((d) => d.contactId === draft.contactId);
      const ok = decision?.approve === true && decision.draftHash === draft.draftHash;
      await audit(s.runId, "decision", draft.contactId, {
        approved: ok,
        reviewer: input.reviewer,
        draftHash: draft.draftHash,
        hashMatched: decision?.draftHash === draft.draftHash,
      });
      if (ok) approved.push(draft);
      else
        outcomes.push({
          contactId: draft.contactId,
          customerName: draft.customerName,
          action: "chase",
          facts: draft.facts,
          delivery: "rejected",
          note: decision ? "not approved" : "no decision given",
        });
    }
    return { approved, outcomes };
  }

  /** Re-reads the invoices, then sends with the lost-reply-safe protocol. */
  async function sendNode(s: S): Promise<Partial<S>> {
    const outcomes: CustomerOutcome[] = [];
    for (const draft of s.approved) {
      const base = {
        contactId: draft.contactId,
        customerName: draft.customerName,
        action: "chase" as const,
        facts: draft.facts,
      };
      const fresh = await Promise.all(
        draft.facts.lines.map((l) => deps.accounting.getInvoice(l.invoiceId)),
      );
      const changed = draft.facts.lines.filter(
        (l, i) => fresh[i]?.status !== "AUTHORISED" || owedOn(fresh[i]) !== l.owedCents,
      );
      if (changed.length > 0) {
        const note = `changed since the draft: ${changed.map((l) => l.invoiceNumber).join(", ")}`;
        await audit(s.runId, "send_skipped_stale", draft.contactId, {
          invoices: changed.map((l) => l.invoiceNumber),
        });
        outcomes.push({ ...base, delivery: "stale", note });
        continue;
      }
      const result = await sendReminder(
        deps.outbox,
        deps.store,
        { key: draft.key, contactId: draft.contactId, content: draft.content },
        deps.now,
      );
      await audit(s.runId, "send_result", draft.contactId, {
        state: result.state,
        attempts: result.attempts,
        outboxRef: result.outboxRef,
        note: result.note,
      });
      outcomes.push({
        ...base,
        delivery: result.state,
        outboxRef: result.outboxRef,
        note: result.note,
        sentContent: draft.content,
      });
    }
    return { outcomes };
  }

  return new StateGraph(State)
    .addNode("assess", assessNode)
    .addNode("draft", draftNode)
    .addNode("approve", approveNode)
    .addNode("send", sendNode)
    .addEdge(START, "assess")
    .addEdge("assess", "draft")
    .addEdge("draft", "approve")
    .addEdge("approve", "send")
    .addEdge("send", END)
    .compile({ checkpointer });
}

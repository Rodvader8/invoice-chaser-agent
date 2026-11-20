import { Chaser } from "../src/chaser.js";
import { AccountingClient } from "../src/clients/accounting.js";
import { JobsClient } from "../src/clients/jobs.js";
import type { CustomerOutcome } from "../src/graph.js";
import { ScriptedModel, type ScriptedBehaviour } from "../src/model/scripted.js";
import { OutboxClient } from "../src/send/outbox-client.js";
import { AccountingStandIn } from "../src/standins/accounting.js";
import { JobsStandIn } from "../src/standins/jobs.js";
import { OutboxStandIn, type OutboxMessage } from "../src/standins/outbox.js";
import { SqliteStore } from "../src/storage/sqlite.js";
import type { EvalCase } from "./cases.js";

export interface CaseRun {
  /** Outcomes per run (1 or 2 runs). */
  runs: CustomerOutcome[][];
  /** Messages the outbox holds at the end. */
  messages: OutboxMessage[];
  /** Customer drafts that reached the approval step, per run. */
  draftsShown: string[][];
}

/** Runs one case end to end: real HTTP stand-ins, real graph, scripted model, in-memory SQLite. */
export async function runCase(
  c: EvalCase,
  options: { clientTimeoutMs?: number } = {},
): Promise<CaseRun> {
  const accounting = new AccountingStandIn({ contacts: c.contacts, invoices: c.invoices });
  const jobs = new JobsStandIn(c.jobs);
  const outbox = new OutboxStandIn({
    dedupe: false,
    postFaults: c.outboxFaults.post,
    getFaults: c.outboxFaults.get,
    stallMs: 1500,
  });
  const servers = await Promise.all([accounting.start(), jobs.start(), outbox.start()]);
  const [accUrl, jobsUrl, outboxUrl] = servers.map((s) => s.url);
  const store = new SqliteStore(":memory:");
  try {
    const chaser = new Chaser({
      accounting: new AccountingClient(accUrl ?? ""),
      jobs: new JobsClient(jobsUrl ?? ""),
      outbox: new OutboxClient(outboxUrl ?? "", options.clientTimeoutMs ?? 300),
      model: new ScriptedModel(c.model as ScriptedBehaviour),
      store,
      now: () => new Date(`${c.asOf}T09:00:00+11:00`),
    });
    const runs: CustomerOutcome[][] = [];
    const draftsShown: string[][] = [];
    for (let i = 0; i < c.runs; i++) {
      let view = await chaser.start(c.asOf);
      draftsShown.push(view.drafts.map((d) => d.contactId));
      if (view.status === "awaiting_approval") {
        if (i === 0 && c.paymentBetweenApprovalAndSend) {
          accounting.addPayment(
            c.paymentBetweenApprovalAndSend.InvoiceNumber,
            c.paymentBetweenApprovalAndSend.Amount,
          );
        }
        view = await chaser.decide(view.runId, {
          reviewer: "eval",
          decisions: view.drafts.map((d) => ({
            contactId: d.contactId,
            approve: c.decision === "approve",
            draftHash: d.draftHash,
          })),
        });
      }
      runs.push(view.outcomes);
    }
    return { runs, messages: [...outbox.messages], draftsShown };
  } finally {
    store.close();
    await Promise.all(servers.map((s) => s.close()));
  }
}

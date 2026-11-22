import { randomUUID } from "node:crypto";
import { Command, MemorySaver, type BaseCheckpointSaver } from "@langchain/langgraph";
import type { AccountingApi } from "./clients/accounting.js";
import type { JobsApi } from "./clients/jobs.js";
import { BUSINESS, type Business } from "./config.js";
import { buildGraph, DecisionInput, type CustomerOutcome, type PendingDraft } from "./graph.js";
import type { ChatModel } from "./model/types.js";
import { sydneyDate } from "./money.js";
import type { Outbox } from "./send/outbox-client.js";
import type { Store } from "./storage/types.js";

export interface ChaserDeps {
  accounting: AccountingApi;
  jobs: JobsApi;
  outbox: Outbox;
  model: ChatModel;
  store: Store;
  business?: Business;
  now?: () => Date;
  /**
   * Where a run waiting for approval is kept. Defaults to in-memory (lost on restart);
   * KvCheckpointSaver persists it in SQLite or DynamoDB.
   */
  checkpointer?: BaseCheckpointSaver;
}

export interface RunView {
  runId: string;
  status: "awaiting_approval" | "done";
  /** Drafts waiting for a person. Empty once the run is done. */
  drafts: PendingDraft[];
  /** Per customer: skipped, held, or what happened to the reminder. Complete once done. */
  outcomes: CustomerOutcome[];
}

export class UnknownRunError extends Error {}
export class RunStateError extends Error {}

/** The service: start a run, show drafts, take decisions, send. Used by the HTTP API, the CLI and the evaluation. */
export class Chaser {
  private readonly graph;
  private readonly now: () => Date;
  private readonly store: Store;

  constructor(deps: ChaserDeps) {
    this.now = deps.now ?? (() => new Date());
    this.store = deps.store;
    this.graph = buildGraph(
      {
        accounting: deps.accounting,
        jobs: deps.jobs,
        outbox: deps.outbox,
        model: deps.model,
        store: deps.store,
        business: deps.business ?? BUSINESS,
        now: this.now,
      },
      deps.checkpointer ?? new MemorySaver(),
    );
  }

  async start(asOf?: string): Promise<RunView> {
    const runId = randomUUID();
    await this.graph.invoke({ runId, asOf: asOf ?? sydneyDate(this.now()) }, this.config(runId));
    return this.view(runId);
  }

  async decide(runId: string, input: unknown): Promise<RunView> {
    const decisions = DecisionInput.parse(input);
    const current = await this.view(runId);
    if (current.status !== "awaiting_approval") {
      throw new RunStateError("run isn't waiting for approval");
    }
    // A stored conditional write, so only one caller resumes a run, even across processes.
    if (!(await this.store.claimRun(runId))) {
      throw new RunStateError("a decision for this run has already been taken");
    }
    try {
      await this.graph.invoke(new Command({ resume: decisions }), this.config(runId));
      return await this.view(runId);
    } catch (err) {
      await this.store.releaseRun(runId);
      throw err;
    }
  }

  async view(runId: string): Promise<RunView> {
    const state = await this.graph.getState(this.config(runId));
    if (Object.keys(state.values as object).length === 0) throw new UnknownRunError("no such run");
    const values = state.values as { drafts?: PendingDraft[]; outcomes?: CustomerOutcome[] };
    const waiting = state.next.includes("approve");
    return {
      runId,
      status: waiting ? "awaiting_approval" : "done",
      drafts: waiting ? (values.drafts ?? []) : [],
      outcomes: values.outcomes ?? [],
    };
  }

  private config(runId: string) {
    return { configurable: { thread_id: runId } };
  }
}

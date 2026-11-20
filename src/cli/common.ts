import { readFileSync } from "node:fs";
import { z } from "zod";
import { AccountingClient } from "../clients/accounting.js";
import { JobsClient } from "../clients/jobs.js";
import type { RunningServer } from "../http.js";
import { OpenRouterModel, openRouterBalanceUsd } from "../model/openrouter.js";
import { ScriptedModel } from "../model/scripted.js";
import { SpendGuard } from "../model/spend.js";
import type { ChatModel } from "../model/types.js";
import { OutboxClient } from "../send/outbox-client.js";
import { AccountingStandIn } from "../standins/accounting.js";
import { JobsStandIn } from "../standins/jobs.js";
import { OutboxStandIn } from "../standins/outbox.js";
import { World } from "../standins/world.js";
import type { Store } from "../storage/types.js";

export const Seed = World.extend({ asOf: z.string() });

export function loadSeed(): z.infer<typeof Seed> {
  return Seed.parse(
    JSON.parse(readFileSync(new URL("../../data/seed.json", import.meta.url), "utf8")),
  );
}

export interface Connections {
  accounting: AccountingClient;
  jobs: JobsClient;
  outbox: OutboxClient;
  outboxStandIn: OutboxStandIn | null;
  seedAsOf: string;
  close(): Promise<void>;
}

/**
 * Uses ACCOUNTING_URL, JOBS_URL and OUTBOX_URL if all three are set; otherwise starts the
 * stand-ins in this process with the invented seed data (nothing is printed to stdout).
 */
export async function connect(ports: [number, number, number] = [0, 0, 0]): Promise<Connections> {
  const seed = loadSeed();
  const { ACCOUNTING_URL, JOBS_URL, OUTBOX_URL } = process.env;
  if (ACCOUNTING_URL && JOBS_URL && OUTBOX_URL) {
    return {
      accounting: new AccountingClient(ACCOUNTING_URL),
      jobs: new JobsClient(JOBS_URL),
      outbox: new OutboxClient(OUTBOX_URL),
      outboxStandIn: null,
      seedAsOf: seed.asOf,
      close: () => Promise.resolve(),
    };
  }
  const outboxStandIn = new OutboxStandIn();
  const servers: RunningServer[] = await Promise.all([
    new AccountingStandIn(seed).start(ports[0]),
    new JobsStandIn(seed.jobs).start(ports[1]),
    outboxStandIn.start(ports[2]),
  ]);
  const [acc, jobs, out] = servers.map((s) => s.url);
  return {
    accounting: new AccountingClient(acc ?? ""),
    jobs: new JobsClient(jobs ?? ""),
    outbox: new OutboxClient(out ?? ""),
    outboxStandIn,
    seedAsOf: seed.asOf,
    close: async () => {
      await Promise.all(servers.map((s) => s.close()));
    },
  };
}

function numberFromEnv(name: string, fallback?: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    if (fallback === undefined) throw new Error(`set ${name}`);
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

/**
 * The scripted model unless `live` is true. A live model needs OPENROUTER_API_KEY,
 * INVOICE_CHASER_MODEL and the model's prices, and runs under hard spend caps.
 */
export function makeModel(store: Store, live: boolean): ChatModel {
  if (!live) return new ScriptedModel("faithful");
  const apiKey = process.env.OPENROUTER_API_KEY ?? "";
  const model = process.env.INVOICE_CHASER_MODEL ?? "";
  if (!apiKey || !model)
    throw new Error("a live run needs OPENROUTER_API_KEY and INVOICE_CHASER_MODEL");
  const guard = new SpendGuard(
    {
      runCapUsd: numberFromEnv("INVOICE_CHASER_RUN_CAP_USD", 0.05),
      projectCapUsd: numberFromEnv("INVOICE_CHASER_PROJECT_CAP_USD", 0.5),
      accountFloorUsd: numberFromEnv("INVOICE_CHASER_ACCOUNT_FLOOR_USD", 1),
    },
    store,
    () => openRouterBalanceUsd(apiKey),
  );
  return new OpenRouterModel({
    apiKey,
    model,
    priceInPerMTok: numberFromEnv("INVOICE_CHASER_PRICE_IN_PER_MTOK"),
    priceOutPerMTok: numberFromEnv("INVOICE_CHASER_PRICE_OUT_PER_MTOK"),
    guard,
  });
}

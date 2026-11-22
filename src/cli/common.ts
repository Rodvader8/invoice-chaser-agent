import { AccountingClient } from "../clients/accounting.js";
import { JobsClient } from "../clients/jobs.js";
import type { RunningServer } from "../http.js";
import { makeModel as makeModelWith } from "../model/factory.js";
import type { ChatModel } from "../model/types.js";
import { loadSeed } from "../seed.js";
import { OutboxClient } from "../send/outbox-client.js";
import { AccountingStandIn } from "../standins/accounting.js";
import { JobsStandIn } from "../standins/jobs.js";
import { OutboxStandIn } from "../standins/outbox.js";
import type { Store } from "../storage/types.js";

export { loadSeed } from "../seed.js";

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

/** The scripted model unless `live`; a live one reads OPENROUTER_API_KEY from the environment. */
export function makeModel(store: Store, live: boolean): ChatModel {
  return makeModelWith(store, {
    live,
    apiKey: process.env.OPENROUTER_API_KEY ?? "",
    env: process.env,
  });
}

import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { Chaser } from "../chaser.js";
import { AccountingClient } from "../clients/accounting.js";
import { JobsClient } from "../clients/jobs.js";
import { makeModel } from "../model/factory.js";
import type { ChatModel } from "../model/types.js";
import { loadSeed } from "../seed.js";
import { OutboxClient } from "../send/outbox-client.js";
import { createRouter, type ApiRequest, type ApiResponse } from "../service/api.js";
import { AccountingStandIn } from "../standins/accounting.js";
import { DynamoDbMessageLog } from "../standins/dynamodb-log.js";
import { JobsStandIn } from "../standins/jobs.js";
import { OutboxStandIn, type MessageLog } from "../standins/outbox.js";
import { DynamoDbCheckpointKv, KvCheckpointSaver } from "../storage/checkpoint.js";
import { documentClient, DynamoDbStore } from "../storage/dynamodb.js";
import type { Store } from "../storage/types.js";
import type { Secrets } from "./secrets.js";

export interface Runtime {
  route(req: ApiRequest): Promise<ApiResponse>;
}

/**
 * Everything one container needs: the stand-ins (in-process, seed data, still no real Xero or
 * ServiceM8), the store, the checkpointer and the model, behind the shared router.
 */
export async function buildRuntime(parts: {
  store: Store;
  checkpointer: BaseCheckpointSaver;
  messageLog?: MessageLog;
  model: ChatModel;
  apiToken: string;
}): Promise<Runtime> {
  const seed = loadSeed();
  const servers = await Promise.all([
    new AccountingStandIn(seed).start(),
    new JobsStandIn(seed.jobs).start(),
    new OutboxStandIn(parts.messageLog ? { log: parts.messageLog } : {}).start(),
  ]);
  const [acc, jobs, out] = servers.map((s) => s.url);
  const chaser = new Chaser({
    accounting: new AccountingClient(acc ?? ""),
    jobs: new JobsClient(jobs ?? ""),
    outbox: new OutboxClient(out ?? ""),
    model: parts.model,
    store: parts.store,
    checkpointer: parts.checkpointer,
  });
  return { route: createRouter(chaser, parts.apiToken) };
}

/** The AWS wiring: everything persistent lives in the one DynamoDB table named by TABLE_NAME. */
export async function buildAwsRuntime(
  secrets: Secrets,
  env: Record<string, string | undefined>,
): Promise<Runtime> {
  const tableName = env.TABLE_NAME;
  if (!tableName) throw new Error("set TABLE_NAME");
  const doc = documentClient();
  const store = new DynamoDbStore(doc, tableName);
  return buildRuntime({
    store,
    checkpointer: new KvCheckpointSaver(new DynamoDbCheckpointKv(doc, tableName)),
    messageLog: new DynamoDbMessageLog(doc, tableName),
    model: makeModel(store, {
      live: env.INVOICE_CHASER_LIVE === "1",
      apiKey: secrets.openrouterKey,
      env,
    }),
    apiToken: secrets.apiToken,
  });
}

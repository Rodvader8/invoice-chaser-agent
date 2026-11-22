import {
  ConditionalCheckFailedException,
  CreateTableCommand,
  DynamoDBClient,
  type DynamoDBClientConfig,
} from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  type NativeAttributeValue,
} from "@aws-sdk/lib-dynamodb";
import {
  DuplicateDeliveryError,
  type AuditEvent,
  type DeliveryPatch,
  type DeliveryRecord,
  type Store,
} from "./types.js";

/**
 * The AWS store: one DynamoDB table, partition key `pk`, sort key `sk`, both strings.
 *
 * | item            | pk                     | sk                              |
 * |-----------------|------------------------|---------------------------------|
 * | delivery        | `DELIVERY#<key>`       | `DELIVERY`                      |
 * | audit event     | `RUN#<runId>`          | `AUDIT#<iso time>#<seq>`        |
 * | run claim       | `RUN#<runId>`          | `CLAIM`                         |
 * | spend total     | `SPEND`                | `TOTAL`                         |
 * | checkpoints     | `CKPT#<threadId>`      | see storage/checkpoint.ts       |
 * | outbox messages | `OUTBOX#<clientRef>`   | `MSG#<id>` (stand-in outbox)    |
 *
 * Send-once rests on two conditional writes: a delivery is inserted only if its key doesn't
 * exist (`attribute_not_exists(pk)`), and a run is claimed only if no claim exists.
 * listDeliveries and listAudit without a run id scan the table: fine for a demo, not at scale.
 */

export type Item = Record<string, NativeAttributeValue>;

/** A document client for a table. `endpoint` is for DynamoDB Local in tests. */
export function documentClient(config: DynamoDBClientConfig = {}): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient(config), {
    marshallOptions: { removeUndefinedValues: true },
  });
}

/** Creates the table the way the CDK stack does (5 and 5 provisioned). Tests use it on DynamoDB Local. */
export async function createTable(doc: DynamoDBDocumentClient, tableName: string): Promise<void> {
  await doc.send(
    new CreateTableCommand({
      TableName: tableName,
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
    }),
  );
}

/** Every item under one partition key whose sort key starts with a prefix, following pages. */
export async function queryAll(
  doc: DynamoDBDocumentClient,
  tableName: string,
  pk: string,
  skPrefix: string,
  options: { descending?: boolean; limit?: number } = {},
): Promise<Item[]> {
  const items: Item[] = [];
  let start: Item | undefined;
  do {
    const page = await doc.send(
      new QueryCommand({
        TableName: tableName,
        // DynamoDB rejects begins_with(sk, ""), so an empty prefix means "the whole partition".
        KeyConditionExpression: skPrefix ? "pk = :pk AND begins_with(sk, :prefix)" : "pk = :pk",
        ExpressionAttributeValues: skPrefix ? { ":pk": pk, ":prefix": skPrefix } : { ":pk": pk },
        ScanIndexForward: !options.descending,
        ConsistentRead: true,
        ExclusiveStartKey: start,
        ...(options.limit ? { Limit: options.limit - items.length } : {}),
      }),
    );
    items.push(...((page.Items ?? []) as Item[]));
    start = page.LastEvaluatedKey as Item | undefined;
  } while (start && (options.limit === undefined || items.length < options.limit));
  return items;
}

async function scanAll(
  doc: DynamoDBDocumentClient,
  tableName: string,
  pkPrefix: string,
  sk?: string,
): Promise<Item[]> {
  const items: Item[] = [];
  let start: Item | undefined;
  do {
    const page = await doc.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: sk
          ? "begins_with(pk, :p) AND begins_with(sk, :s)"
          : "begins_with(pk, :p)",
        ExpressionAttributeValues: sk ? { ":p": pkPrefix, ":s": sk } : { ":p": pkPrefix },
        ConsistentRead: true,
        ExclusiveStartKey: start,
      }),
    );
    items.push(...((page.Items ?? []) as Item[]));
    start = page.LastEvaluatedKey as Item | undefined;
  } while (start);
  return items;
}

function toDelivery(item: Item): DeliveryRecord {
  return {
    key: item.key as string,
    contactId: item.contactId as string,
    channel: item.channel as DeliveryRecord["channel"],
    recipient: item.recipient as string,
    contentHash: item.contentHash as string,
    state: item.state as DeliveryRecord["state"],
    attempts: item.attempts as number,
    outboxRef: (item.outboxRef as string | undefined) ?? null,
    lastError: (item.lastError as string | undefined) ?? null,
    createdAt: item.createdAt as string,
    updatedAt: item.updatedAt as string,
  };
}

export class DynamoDbStore implements Store {
  private seq = 0;

  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getDelivery(key: string): Promise<DeliveryRecord | null> {
    const out = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: `DELIVERY#${key}`, sk: "DELIVERY" },
        ConsistentRead: true,
      }),
    );
    return out.Item ? toDelivery(out.Item) : null;
  }

  async insertDelivery(record: DeliveryRecord): Promise<void> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { pk: `DELIVERY#${record.key}`, sk: "DELIVERY", ...record },
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException)
        throw new DuplicateDeliveryError(record.key);
      throw err;
    }
  }

  async updateDelivery(key: string, patch: DeliveryPatch): Promise<void> {
    const names: Record<string, string> = { "#updatedAt": "updatedAt" };
    const values: Item = { ":updatedAt": this.now().toISOString() };
    const sets = ["#updatedAt = :updatedAt"];
    for (const [field, value] of Object.entries(patch)) {
      names[`#${field}`] = field;
      values[`:${field}`] = value;
      sets.push(`#${field} = :${field}`);
    }
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: `DELIVERY#${key}`, sk: "DELIVERY" },
          UpdateExpression: `SET ${sets.join(", ")}`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ConditionExpression: "attribute_exists(pk)",
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException)
        throw new Error(`no delivery ${key}`, { cause: err });
      throw err;
    }
  }

  async listDeliveries(): Promise<DeliveryRecord[]> {
    const items = await scanAll(this.doc, this.tableName, "DELIVERY#", "DELIVERY");
    return items
      .map(toDelivery)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key));
  }

  async appendAudit(e: AuditEvent): Promise<void> {
    this.seq += 1;
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: `RUN#${e.runId}`,
          sk: `AUDIT#${e.at}#${String(this.seq).padStart(8, "0")}`,
          at: e.at,
          runId: e.runId,
          type: e.type,
          contactId: e.contactId,
          detail: JSON.stringify(e.detail),
        },
      }),
    );
  }

  async listAudit(runId?: string): Promise<AuditEvent[]> {
    const items =
      runId === undefined
        ? (await scanAll(this.doc, this.tableName, "RUN#", "AUDIT#")).sort((a, b) =>
            String(a.sk).localeCompare(String(b.sk)),
          )
        : await queryAll(this.doc, this.tableName, `RUN#${runId}`, "AUDIT#");
    return items.map((i) => ({
      at: i.at as string,
      runId: i.runId as string,
      type: i.type as string,
      contactId: (i.contactId as string | null | undefined) ?? null,
      detail: JSON.parse(i.detail as string) as Record<string, unknown>,
    }));
  }

  async addSpend(usd: number): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: "SPEND", sk: "TOTAL" },
        UpdateExpression: "ADD usd :usd",
        ExpressionAttributeValues: { ":usd": usd },
      }),
    );
  }

  async totalSpendUsd(): Promise<number> {
    const out = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: "SPEND", sk: "TOTAL" },
        ConsistentRead: true,
      }),
    );
    return (out.Item?.usd as number | undefined) ?? 0;
  }

  async claimRun(runId: string): Promise<boolean> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { pk: `RUN#${runId}`, sk: "CLAIM", claimedAt: this.now().toISOString() },
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }

  async releaseRun(runId: string): Promise<void> {
    await this.doc.send(
      new DeleteCommand({ TableName: this.tableName, Key: { pk: `RUN#${runId}`, sk: "CLAIM" } }),
    );
  }

  close(): void {
    // The document client is owned by whoever created it.
  }
}

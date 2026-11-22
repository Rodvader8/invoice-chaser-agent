import { DatabaseSync } from "node:sqlite";
import type { RunnableConfig } from "@langchain/core/runnables";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  BaseCheckpointSaver,
  compareWritesSortKeys,
  copyCheckpoint,
  getCheckpointId,
  WRITES_IDX_MAP,
  writesSortKey,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointPendingWrite,
  type CheckpointTuple,
  type PendingWrite,
  type SerializerProtocol,
} from "@langchain/langgraph-checkpoint";
import { queryAll } from "./dynamodb.js";

/**
 * A persisted LangGraph checkpointer, so a run waiting for approval survives a restart (or, on
 * Lambda, a different container answering the next request). Written for this repo because no
 * maintained DynamoDB checkpointer for LangGraph.js exists; it follows MemorySaver's behaviour.
 *
 * It sits on a minimal sorted key-value interface with two backends: DynamoDB (the AWS table)
 * and SQLite (local runs and tests that don't need Docker).
 *
 * Keys, one partition per thread:
 *   pk = CKPT#<thread>
 *   checkpoint: sk = C#<ns>#<checkpoint id>            (ids are time-ordered uuid6)
 *   write:      sk = W#<ns>#<checkpoint id>#<task>#<idx>
 *
 * Limits: list() needs a thread id (listing every thread would need a table scan, and nothing
 * here does it); checkpoints written by LangGraph versions before checkpoint format 4 aren't
 * migrated; a DynamoDB item is capped at 400 KB, which bounds the state of one run.
 */
export interface CheckpointKv {
  put(pk: string, sk: string, value: Record<string, string>, onlyIfAbsent: boolean): Promise<void>;
  get(pk: string, sk: string): Promise<Record<string, string> | undefined>;
  query(
    pk: string,
    skPrefix: string,
    options?: { descending?: boolean; limit?: number },
  ): Promise<{ sk: string; value: Record<string, string> }[]>;
  deletePartition(pk: string): Promise<void>;
}

const enc = (part: string) => encodeURIComponent(part);
const pkFor = (thread: string) => `CKPT#${enc(thread)}`;
const checkpointPrefix = (ns: string) => `C#${enc(ns)}#`;
const writesPrefix = (ns: string, id: string) => `W#${enc(ns)}#${enc(id)}#`;
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const unb64 = (text: string) => new Uint8Array(Buffer.from(text, "base64"));

function threadOf(config: RunnableConfig): string | undefined {
  const id: unknown = config.configurable?.thread_id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function nsOf(config: RunnableConfig): string {
  const ns: unknown = config.configurable?.checkpoint_ns;
  return typeof ns === "string" ? ns : "";
}

export class KvCheckpointSaver extends BaseCheckpointSaver {
  constructor(
    private readonly kv: CheckpointKv,
    serde?: SerializerProtocol,
  ) {
    super(serde);
  }

  private async pendingWrites(
    thread: string,
    ns: string,
    id: string,
  ): Promise<CheckpointPendingWrite[]> {
    const rows = await this.kv.query(pkFor(thread), writesPrefix(ns, id));
    const keyed = rows.map(({ value }) => ({
      key: writesSortKey(value.taskPath ?? "", value.taskId, Number(value.idx)),
      value,
    }));
    keyed.sort((a, b) => compareWritesSortKeys(a.key, b.key));
    return Promise.all(
      keyed.map(async ({ value }): Promise<CheckpointPendingWrite> => [
        value.taskId ?? "",
        value.channel ?? "",
        (await this.serde.loadsTyped(value.type ?? "json", unb64(value.value ?? ""))) as unknown,
      ]),
    );
  }

  private async toTuple(
    thread: string,
    ns: string,
    sk: string,
    value: Record<string, string>,
  ): Promise<CheckpointTuple> {
    const id = decodeURIComponent(sk.slice(checkpointPrefix(ns).length));
    const tuple: CheckpointTuple = {
      config: { configurable: { thread_id: thread, checkpoint_ns: ns, checkpoint_id: id } },
      checkpoint: (await this.serde.loadsTyped(
        value.type ?? "json",
        unb64(value.checkpoint ?? ""),
      )) as Checkpoint,
      metadata: (await this.serde.loadsTyped(
        value.metadataType ?? "json",
        unb64(value.metadata ?? ""),
      )) as CheckpointMetadata,
      pendingWrites: await this.pendingWrites(thread, ns, id),
    };
    if (value.parent) {
      tuple.parentConfig = {
        configurable: { thread_id: thread, checkpoint_ns: ns, checkpoint_id: value.parent },
      };
    }
    return tuple;
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const thread = threadOf(config);
    if (!thread) return undefined;
    const ns = nsOf(config);
    const id = getCheckpointId(config);
    if (id) {
      const sk = `${checkpointPrefix(ns)}${enc(id)}`;
      const value = await this.kv.get(pkFor(thread), sk);
      return value ? this.toTuple(thread, ns, sk, value) : undefined;
    }
    const [latest] = await this.kv.query(pkFor(thread), checkpointPrefix(ns), {
      descending: true,
      limit: 1,
    });
    return latest ? this.toTuple(thread, ns, latest.sk, latest.value) : undefined;
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const thread = threadOf(config);
    if (!thread) throw new Error("KvCheckpointSaver.list needs a thread_id");
    const nsFilter: unknown = config.configurable?.checkpoint_ns;
    const idFilter = getCheckpointId(config);
    const before = options?.before ? getCheckpointId(options.before) : undefined;
    let remaining = options?.limit;
    const rows = await this.kv.query(
      pkFor(thread),
      typeof nsFilter === "string" ? checkpointPrefix(nsFilter) : "C#",
      {
        descending: true,
      },
    );
    for (const { sk, value } of rows) {
      const [, rawNs = "", rawId = ""] = sk.split("#");
      const ns = decodeURIComponent(rawNs);
      const id = decodeURIComponent(rawId);
      if (idFilter && id !== idFilter) continue;
      if (before && id >= before) continue;
      const tuple = await this.toTuple(thread, ns, sk, value);
      const filter = options?.filter;
      const metadata = tuple.metadata as Record<string, unknown> | undefined;
      if (filter && !Object.entries(filter).every(([k, v]) => metadata?.[k] === v)) continue;
      if (remaining !== undefined) {
        if (remaining <= 0) break;
        remaining -= 1;
      }
      yield tuple;
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    const thread = threadOf(config);
    if (!thread) throw new Error('Failed to put checkpoint: the config has no "thread_id"');
    const ns = nsOf(config);
    const [[type, bytes], [metadataType, metadataBytes]] = await Promise.all([
      this.serde.dumpsTyped(copyCheckpoint(checkpoint)),
      this.serde.dumpsTyped(metadata),
    ]);
    const parent = getCheckpointId(config);
    await this.kv.put(
      pkFor(thread),
      `${checkpointPrefix(ns)}${enc(checkpoint.id)}`,
      {
        type,
        checkpoint: b64(bytes),
        metadataType,
        metadata: b64(metadataBytes),
        ...(parent ? { parent } : {}),
      },
      false,
    );
    return { configurable: { thread_id: thread, checkpoint_ns: ns, checkpoint_id: checkpoint.id } };
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
    taskPath?: string,
  ): Promise<void> {
    const thread = threadOf(config);
    const id = getCheckpointId(config);
    if (!thread || !id)
      throw new Error('Failed to put writes: the config needs "thread_id" and "checkpoint_id"');
    const ns = nsOf(config);
    await Promise.all(
      writes.map(async ([channel, value], i) => {
        const idx = WRITES_IDX_MAP[channel] ?? i;
        const [type, bytes] = await this.serde.dumpsTyped(value);
        // Ordinary writes keep the first value (as MemorySaver does); special channels overwrite.
        await this.kv.put(
          pkFor(thread),
          `${writesPrefix(ns, id)}${enc(taskId)}#${idx}`,
          { taskId, channel, type, value: b64(bytes), taskPath: taskPath ?? "", idx: String(idx) },
          idx >= 0,
        );
      }),
    );
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.kv.deletePartition(pkFor(threadId));
  }
}

/** Checkpoints in the DynamoDB table. */
export class DynamoDbCheckpointKv implements CheckpointKv {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async put(
    pk: string,
    sk: string,
    value: Record<string, string>,
    onlyIfAbsent: boolean,
  ): Promise<void> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { pk, sk, value },
          ...(onlyIfAbsent ? { ConditionExpression: "attribute_not_exists(pk)" } : {}),
        }),
      );
    } catch (err) {
      if (!(onlyIfAbsent && err instanceof ConditionalCheckFailedException)) throw err;
    }
  }

  async get(pk: string, sk: string): Promise<Record<string, string> | undefined> {
    const out = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { pk, sk }, ConsistentRead: true }),
    );
    return out.Item?.value as Record<string, string> | undefined;
  }

  async query(
    pk: string,
    skPrefix: string,
    options: { descending?: boolean; limit?: number } = {},
  ) {
    const items = await queryAll(this.doc, this.tableName, pk, skPrefix, options);
    return items.map((i) => ({ sk: i.sk as string, value: i.value as Record<string, string> }));
  }

  async deletePartition(pk: string): Promise<void> {
    const items = await queryAll(this.doc, this.tableName, pk, "");
    for (const i of items) {
      await this.doc.send(
        new DeleteCommand({ TableName: this.tableName, Key: { pk, sk: i.sk as string } }),
      );
    }
  }
}

/** Checkpoints in a SQLite file (or ":memory:"). */
export class SqliteCheckpointKv implements CheckpointKv {
  private readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS checkpoint_kv (pk TEXT NOT NULL, sk TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (pk, sk))",
    );
  }

  put(pk: string, sk: string, value: Record<string, string>, onlyIfAbsent: boolean): Promise<void> {
    const verb = onlyIfAbsent ? "INSERT OR IGNORE" : "INSERT OR REPLACE";
    this.db
      .prepare(`${verb} INTO checkpoint_kv (pk, sk, value) VALUES (?, ?, ?)`)
      .run(pk, sk, JSON.stringify(value));
    return Promise.resolve();
  }

  get(pk: string, sk: string): Promise<Record<string, string> | undefined> {
    const row = this.db
      .prepare("SELECT value FROM checkpoint_kv WHERE pk = ? AND sk = ?")
      .get(pk, sk) as { value: string } | undefined;
    return Promise.resolve(row ? (JSON.parse(row.value) as Record<string, string>) : undefined);
  }

  query(pk: string, skPrefix: string, options: { descending?: boolean; limit?: number } = {}) {
    const rows = this.db
      .prepare(
        `SELECT sk, value FROM checkpoint_kv WHERE pk = ? AND substr(sk, 1, ?) = ? ORDER BY sk ${options.descending ? "DESC" : "ASC"} LIMIT ?`,
      )
      .all(pk, skPrefix.length, skPrefix, options.limit ?? -1) as unknown as {
      sk: string;
      value: string;
    }[];
    return Promise.resolve(
      rows.map((r) => ({ sk: r.sk, value: JSON.parse(r.value) as Record<string, string> })),
    );
  }

  deletePartition(pk: string): Promise<void> {
    this.db.prepare("DELETE FROM checkpoint_kv WHERE pk = ?").run(pk);
    return Promise.resolve();
  }

  close(): void {
    this.db.close();
  }
}

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyCheckpoint,
  type Checkpoint,
  type CheckpointMetadata,
} from "@langchain/langgraph-checkpoint";
import { afterEach, describe, expect, it } from "vitest";
import { Chaser, RunStateError } from "../src/chaser.js";
import { AccountingClient } from "../src/clients/accounting.js";
import { JobsClient } from "../src/clients/jobs.js";
import type { RunningServer } from "../src/http.js";
import { ScriptedModel } from "../src/model/scripted.js";
import { OutboxClient } from "../src/send/outbox-client.js";
import { AccountingStandIn } from "../src/standins/accounting.js";
import { JobsStandIn } from "../src/standins/jobs.js";
import { OutboxStandIn } from "../src/standins/outbox.js";
import {
  DynamoDbCheckpointKv,
  KvCheckpointSaver,
  type CheckpointKv,
} from "../src/storage/checkpoint.js";
import { SqliteCheckpointKv } from "../src/storage/checkpoint-sqlite.js";
import { DynamoDbStore } from "../src/storage/dynamodb.js";
import { SqliteStore } from "../src/storage/sqlite.js";
import type { Store } from "../src/storage/types.js";
import { dynamoAvailable, dynamoLabel, freshTable, localDoc } from "./dynamo.js";
import { WORLD } from "./world.js";

const meta = (step: number): CheckpointMetadata => ({ source: "loop", step, parents: {} });
const checkpoint = (id: string, value: string): Checkpoint => ({
  ...emptyCheckpoint(),
  id,
  channel_values: { value },
  channel_versions: { value: 1 },
});
const cfg = (thread: string, extra: Record<string, string> = {}) => ({
  configurable: { thread_id: thread, checkpoint_ns: "", ...extra },
});

interface Backend {
  /** A key-value backend; called twice with the same `shared` value, it returns two views of one store. */
  kv(): Promise<CheckpointKv>;
  /** A second process on the same backend: new store, new checkpoint saver. */
  process(): Promise<{ store: Store; kv: CheckpointKv }>;
}

function sqliteBackend(): Backend {
  let path = "";
  return {
    kv: () => {
      path = join(mkdtempSync(join(tmpdir(), "chaser-ckpt-")), "state.db");
      return Promise.resolve(new SqliteCheckpointKv(path));
    },
    process: () =>
      Promise.resolve({ store: new SqliteStore(path), kv: new SqliteCheckpointKv(path) }),
  };
}

function dynamoBackend(): Backend {
  let table = "";
  return {
    kv: async () => {
      table = await freshTable();
      return new DynamoDbCheckpointKv(localDoc(), table);
    },
    process: () =>
      Promise.resolve({
        store: new DynamoDbStore(localDoc(), table),
        kv: new DynamoDbCheckpointKv(localDoc(), table),
      }),
  };
}

const backends: [string, () => Backend, boolean][] = [
  ["KvCheckpointSaver on SQLite", sqliteBackend, true],
  [dynamoLabel("KvCheckpointSaver on DynamoDB"), dynamoBackend, dynamoAvailable],
];

for (const [label, makeBackend, enabled] of backends) {
  describe.skipIf(!enabled)(label, () => {
    it("returns nothing for an unknown thread", async () => {
      const saver = new KvCheckpointSaver(await makeBackend().kv());
      expect(await saver.getTuple(cfg("nope"))).toBeUndefined();
    });

    it("stores checkpoints, returns the latest or a named one, and links parents", async () => {
      const saver = new KvCheckpointSaver(await makeBackend().kv());
      const first = await saver.put(cfg("t1"), checkpoint("0001", "a"), meta(0), {});
      await saver.put(first, checkpoint("0002", "b"), meta(1), {});
      const latest = await saver.getTuple(cfg("t1"));
      expect(latest?.checkpoint.channel_values).toEqual({ value: "b" });
      expect(latest?.parentConfig?.configurable?.checkpoint_id).toBe("0001");
      expect(latest?.metadata?.step).toBe(1);
      const named = await saver.getTuple(cfg("t1", { checkpoint_id: "0001" }));
      expect(named?.checkpoint.channel_values).toEqual({ value: "a" });
      expect(named?.parentConfig).toBeUndefined();
    });

    it("keeps pending writes in order; an ordinary write keeps its first value, a special one is replaced", async () => {
      const saver = new KvCheckpointSaver(await makeBackend().kv());
      const at = await saver.put(cfg("t2"), checkpoint("0001", "a"), meta(0), {});
      await saver.putWrites(
        at,
        [
          ["value", "x"],
          ["other", "y"],
        ],
        "task-1",
      );
      await saver.putWrites(at, [["value", "changed"]], "task-1");
      await saver.putWrites(at, [["__interrupt__", "first"]], "task-2");
      await saver.putWrites(at, [["__interrupt__", "second"]], "task-2");
      const writes = (await saver.getTuple(at))?.pendingWrites ?? [];
      expect(writes).toContainEqual(["task-1", "value", "x"]);
      expect(writes).toContainEqual(["task-1", "other", "y"]);
      expect(writes).not.toContainEqual(["task-1", "value", "changed"]);
      expect(writes.filter((w) => w[1] === "__interrupt__")).toEqual([
        ["task-2", "__interrupt__", "second"],
      ]);
    });

    it("lists newest first, with limit, before and metadata filters, and keeps namespaces apart", async () => {
      const saver = new KvCheckpointSaver(await makeBackend().kv());
      for (const [i, id] of ["0001", "0002", "0003"].entries())
        await saver.put(cfg("t3"), checkpoint(id, id), meta(i), {});
      await saver.put(cfg("t3", { checkpoint_ns: "child" }), checkpoint("0009", "c"), meta(9), {});
      const ids = async (options?: Parameters<typeof saver.list>[1], config = cfg("t3")) => {
        const out: string[] = [];
        for await (const t of saver.list(config, options))
          out.push(String(t.config.configurable?.checkpoint_id));
        return out;
      };
      expect(await ids()).toEqual(["0003", "0002", "0001"]);
      expect(await ids({ limit: 2 })).toEqual(["0003", "0002"]);
      expect(await ids({ before: cfg("t3", { checkpoint_id: "0003" }) })).toEqual(["0002", "0001"]);
      expect(await ids({ filter: { step: 1 } })).toEqual(["0002"]);
      expect(await ids(undefined, cfg("t3", { checkpoint_ns: "child" }))).toEqual(["0009"]);
    });

    it("deletes a thread", async () => {
      const saver = new KvCheckpointSaver(await makeBackend().kv());
      const at = await saver.put(cfg("t4"), checkpoint("0001", "a"), meta(0), {});
      await saver.putWrites(at, [["value", "x"]], "task");
      await saver.deleteThread("t4");
      expect(await saver.getTuple(cfg("t4"))).toBeUndefined();
    });

    describe("approve after a restart", () => {
      let servers: RunningServer[] = [];
      afterEach(async () => {
        await Promise.all(servers.map((s) => s.close()));
        servers = [];
      });

      it("a run started by one process is approved and sent by a fresh one; a third can't resume it again", async () => {
        // The stand-ins play the outside systems, so they outlive the "processes".
        const outbox = new OutboxStandIn();
        servers = await Promise.all([
          new AccountingStandIn(WORLD).start(),
          new JobsStandIn(WORLD.jobs).start(),
          outbox.start(),
        ]);
        const [acc, jobs, out] = servers.map((s) => s.url);
        const backend = makeBackend();
        await backend.kv();
        const processFrom = async () => {
          const { store, kv } = await backend.process();
          return new Chaser({
            accounting: new AccountingClient(acc ?? ""),
            jobs: new JobsClient(jobs ?? ""),
            outbox: new OutboxClient(out ?? ""),
            model: new ScriptedModel("faithful"),
            store,
            checkpointer: new KvCheckpointSaver(kv),
          });
        };

        const started = await (await processFrom()).start("2026-11-20");
        expect(started.status).toBe("awaiting_approval");
        // Nothing of the first process is used from here on.

        const fresh = await processFrom();
        const seen = await fresh.view(started.runId);
        expect(seen.status).toBe("awaiting_approval");
        expect(seen.drafts.map((d) => d.draftHash)).toEqual(started.drafts.map((d) => d.draftHash));
        const decisions = seen.drafts.map((d) => ({
          contactId: d.contactId,
          approve: true,
          draftHash: d.draftHash,
        }));
        const done = await fresh.decide(started.runId, { reviewer: "rod", decisions });
        expect(done.status).toBe("done");
        expect(done.outcomes.find((o) => o.contactId === "T1")?.delivery).toBe("sent");
        expect(outbox.messages).toHaveLength(1);

        const third = await processFrom();
        expect((await third.view(started.runId)).status).toBe("done");
        await expect(
          third.decide(started.runId, { reviewer: "rod", decisions }),
        ).rejects.toBeInstanceOf(RunStateError);
        expect(outbox.messages).toHaveLength(1);
      });
    });
  });
}

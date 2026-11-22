import { describe, expect, it } from "vitest";
import type { RunningServer } from "../src/http.js";
import { OutboxClient } from "../src/send/outbox-client.js";
import { sendReminder } from "../src/send/sender.js";
import { OutboxStandIn, type MessageLog, type OutboxMessage } from "../src/standins/outbox.js";
import { DuplicateDeliveryError, type DeliveryRecord, type Store } from "../src/storage/types.js";

export interface StoreFixture {
  /** A store on a fresh backend. */
  open(): Promise<Store>;
  /** A second store on the same backend: a new process, nothing shared in memory. */
  reopen(): Promise<Store>;
  /** A message log for the stand-in outbox on the same backend, or undefined to keep it in memory. */
  messageLog?(): MessageLog;
}

export const record: DeliveryRecord = {
  key: "rem_contract_0001",
  contactId: "C1",
  channel: "email",
  recipient: "a@b.example",
  contentHash: "h",
  state: "sending",
  attempts: 0,
  outboxRef: null,
  lastError: null,
  createdAt: "2026-11-20T00:00:00.000Z",
  updatedAt: "2026-11-20T00:00:00.000Z",
};

const content = {
  channel: "email" as const,
  to: "alex@customer.example",
  subject: "Overdue: INV-1001",
  body: "Total now due: $500.00",
};

/** The behaviour every Store must have. Run against SqliteStore and DynamoDbStore. */
export function storeContract(label: string, fixture: StoreFixture, enabled = true): void {
  describe.skipIf(!enabled)(label, () => {
    it("allows one delivery record per key (a conditional write)", async () => {
      const store = await fixture.open();
      await store.insertDelivery(record);
      await expect(store.insertDelivery(record)).rejects.toBeInstanceOf(DuplicateDeliveryError);
      const racers = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          store.insertDelivery({ ...record, key: "rem_contract_race" }),
        ),
      );
      expect(racers.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    });

    it("updates deliveries and refuses unknown keys", async () => {
      const store = await fixture.open();
      await store.insertDelivery(record);
      await store.updateDelivery(record.key, { state: "sent", attempts: 2, outboxRef: "m1" });
      expect(await store.getDelivery(record.key)).toMatchObject({
        state: "sent",
        attempts: 2,
        outboxRef: "m1",
        lastError: null,
      });
      await expect(store.updateDelivery("rem_nope", { state: "sent" })).rejects.toThrow();
      expect((await store.listDeliveries()).map((d) => d.key)).toEqual([record.key]);
    });

    it("keeps the audit log in order, by run and in total", async () => {
      const store = await fixture.open();
      for (const type of ["a", "b", "c"]) {
        await store.appendAudit({
          at: "2026-11-20T00:00:00.000Z",
          runId: "r1",
          type,
          contactId: null,
          detail: { type },
        });
      }
      await store.appendAudit({
        at: "2026-11-20T00:00:01.000Z",
        runId: "r2",
        type: "d",
        contactId: "C1",
        detail: {},
      });
      expect((await store.listAudit("r1")).map((e) => e.type)).toEqual(["a", "b", "c"]);
      expect((await store.listAudit()).map((e) => e.type)).toEqual(["a", "b", "c", "d"]);
      expect((await store.listAudit("r2"))[0]).toMatchObject({ contactId: "C1", detail: {} });
    });

    it("adds up spend", async () => {
      const store = await fixture.open();
      expect(await store.totalSpendUsd()).toBe(0);
      await store.addSpend(0.25, "m", "p");
      await store.addSpend(0.5, "m", "p");
      expect(await store.totalSpendUsd()).toBeCloseTo(0.75, 10);
    });

    it("lets exactly one caller claim a run, even when they race", async () => {
      const store = await fixture.open();
      const claims = await Promise.all(Array.from({ length: 5 }, () => store.claimRun("run-1")));
      expect(claims.filter(Boolean)).toHaveLength(1);
      await store.releaseRun("run-1");
      expect(await store.claimRun("run-1")).toBe(true);
    });

    it("keeps deliveries, claims, audit and spend for the next process", async () => {
      const first = await fixture.open();
      await first.insertDelivery(record);
      await first.claimRun("run-2");
      await first.appendAudit({
        at: "t",
        runId: "r9",
        type: "x",
        contactId: null,
        detail: { a: 1 },
      });
      await first.addSpend(0.25, "m", "p");
      first.close();
      const second = await fixture.reopen();
      expect(await second.getDelivery(record.key)).not.toBeNull();
      expect(await second.claimRun("run-2")).toBe(false);
      expect(await second.listAudit("r9")).toHaveLength(1);
      expect(await second.totalSpendUsd()).toBe(0.25);
    });

    describe("with the sender and the stand-in outbox", () => {
      const servers: RunningServer[] = [];
      const startOutbox = async (outbox: OutboxStandIn) => {
        const s = await outbox.start();
        servers.push(s);
        return s;
      };
      const stopAll = async () => {
        await Promise.all(servers.splice(0).map((s) => s.close()));
      };

      it("a lost reply plus a retry still gives one message", async () => {
        try {
          const store = await fixture.open();
          const log = fixture.messageLog?.();
          const outbox = new OutboxStandIn({
            postFaults: ["drop_before_apply", "apply_then_drop"],
            ...(log ? { log } : {}),
          });
          const client = new OutboxClient((await startOutbox(outbox)).url, 300);
          const result = await sendReminder(client, store, {
            key: "rem_lost_reply",
            contactId: "C1",
            content,
          });
          expect(result).toMatchObject({ state: "sent", attempts: 2 });
          expect(outbox.messages).toHaveLength(1);
          if (log) expect(await log.byRef("rem_lost_reply")).toHaveLength(1);
          expect((await store.getDelivery("rem_lost_reply"))?.state).toBe("sent");
        } finally {
          await stopAll();
        }
      });

      it("two processes sending the same reminder at once give one message", async () => {
        try {
          const store = await fixture.open();
          const other = await fixture.reopen();
          const outbox = new OutboxStandIn();
          const url = (await startOutbox(outbox)).url;
          const req = { key: "rem_race", contactId: "C1", content };
          const results = await Promise.all([
            sendReminder(new OutboxClient(url), store, req),
            sendReminder(new OutboxClient(url), other, req),
          ]);
          expect(outbox.messages).toHaveLength(1);
          expect(results.map((r) => r.state).sort()).toEqual(["sent", "unknown"]);
        } finally {
          await stopAll();
        }
      });

      if (fixture.messageLog) {
        it("after a cold start, a new outbox instance still finds the message by readback", async () => {
          try {
            const store = await fixture.open();
            const log = fixture.messageLog?.();
            if (!log) return;
            const before = new OutboxStandIn({
              postFaults: ["apply_then_drop"],
              getFaults: ["drop"],
              log,
            });
            const first = await startOutbox(before);
            const req = { key: "rem_cold_start", contactId: "C1", content };
            expect((await sendReminder(new OutboxClient(first.url, 300), store, req)).state).toBe(
              "unknown",
            );
            // A new container: a new outbox instance with nothing in memory, the same log.
            const after = new OutboxStandIn({ log: fixture.messageLog?.() as MessageLog });
            const second = await startOutbox(after);
            const later = await fixture.reopen();
            expect((await sendReminder(new OutboxClient(second.url), later, req)).state).toBe(
              "sent",
            );
            expect(after.messages).toHaveLength(0);
            const all: OutboxMessage[] = await log.byRef("rem_cold_start");
            expect(all).toHaveLength(1);
          } finally {
            await stopAll();
          }
        });
      }
    });
  });
}

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteStore } from "../src/storage/sqlite.js";
import { DuplicateDeliveryError, type DeliveryRecord } from "../src/storage/types.js";

const record: DeliveryRecord = {
  key: "rem_abc",
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

describe("SqliteStore", () => {
  it("allows one delivery record per key", async () => {
    const store = new SqliteStore();
    await store.insertDelivery(record);
    await expect(store.insertDelivery(record)).rejects.toBeInstanceOf(DuplicateDeliveryError);
  });

  it("updates deliveries and refuses unknown keys", async () => {
    const store = new SqliteStore();
    await store.insertDelivery(record);
    await store.updateDelivery("rem_abc", { state: "sent", attempts: 2, outboxRef: "m1" });
    expect(await store.getDelivery("rem_abc")).toMatchObject({
      state: "sent",
      attempts: 2,
      outboxRef: "m1",
    });
    await expect(store.updateDelivery("nope", { state: "sent" })).rejects.toThrow();
  });

  it("keeps deliveries, audit and spend on disk across restarts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chaser-store-"));
    try {
      const path = join(dir, "test.db");
      const first = new SqliteStore(path);
      await first.insertDelivery(record);
      await first.appendAudit({
        at: "t",
        runId: "r1",
        type: "x",
        contactId: null,
        detail: { a: 1 },
      });
      await first.addSpend(0.25, "m", "p");
      first.close();
      const second = new SqliteStore(path);
      expect(await second.getDelivery("rem_abc")).not.toBeNull();
      expect(await second.listAudit("r1")).toHaveLength(1);
      expect(await second.totalSpendUsd()).toBe(0.25);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

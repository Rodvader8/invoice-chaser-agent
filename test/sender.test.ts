import { afterEach, describe, expect, it } from "vitest";
import type { RunningServer } from "../src/http.js";
import { OutboxClient, type Outbox } from "../src/send/outbox-client.js";
import { reconcile, sendReminder } from "../src/send/sender.js";
import { OutboxStandIn, type OutboxOptions } from "../src/standins/outbox.js";
import { SqliteStore } from "../src/storage/sqlite.js";

const content = {
  channel: "email" as const,
  to: "alex@customer.example",
  subject: "Overdue: INV-1001",
  body: "Total now due: $500.00",
};
const request = { key: "rem_test_key_0001", contactId: "C1", content };

let running: RunningServer | null = null;
afterEach(async () => {
  await running?.close();
  running = null;
});

async function setup(options: OutboxOptions = {}, timeoutMs = 300) {
  const outbox = new OutboxStandIn({ stallMs: 1500, ...options });
  running = await outbox.start();
  return { outbox, client: new OutboxClient(running.url, timeoutMs), store: new SqliteStore() };
}

describe("sendReminder against the stand-in outbox over HTTP", () => {
  it("sends once and records the outbox reference", async () => {
    const { outbox, client, store } = await setup();
    const r = await sendReminder(client, store, request);
    expect(r).toMatchObject({ state: "sent", attempts: 1 });
    expect(outbox.messages).toHaveLength(1);
    expect((await store.getDelivery(request.key))?.outboxRef).toBe(outbox.messages[0]?.id);
  });

  it.each(["apply_then_drop", "apply_then_503", "apply_then_stall"] as const)(
    "%s: the readback finds the message, so nothing is sent twice",
    async (fault) => {
      const { outbox, client, store } = await setup({ postFaults: [fault] });
      const r = await sendReminder(client, store, request);
      expect(r.state).toBe("sent");
      expect(outbox.postCount).toBe(1);
      expect(outbox.messages).toHaveLength(1);
    },
  );

  it("dropped before it arrived: the readback finds nothing, so it resends with the same key", async () => {
    const { outbox, client, store } = await setup({ postFaults: ["drop_before_apply"] });
    const r = await sendReminder(client, store, request);
    expect(r).toMatchObject({ state: "sent", attempts: 2 });
    expect(outbox.messages).toHaveLength(1);
  });

  it("gives up after three attempts that never arrive", async () => {
    const { outbox, client, store } = await setup({
      postFaults: ["drop_before_apply", "drop_before_apply", "drop_before_apply"],
    });
    const r = await sendReminder(client, store, request);
    expect(r).toMatchObject({ state: "failed", attempts: 3 });
    expect(outbox.postCount).toBe(3);
  });

  it("readback fails too: unknown, no resend; reconcile settles it later without sending", async () => {
    const { outbox, client, store } = await setup({
      postFaults: ["apply_then_drop"],
      getFaults: ["drop"],
    });
    expect((await sendReminder(client, store, request)).state).toBe("unknown");
    expect(outbox.postCount).toBe(1);
    expect((await reconcile(client, store, request.key)).state).toBe("sent");
    expect(outbox.postCount).toBe(1);
    expect((await store.getDelivery(request.key))?.state).toBe("sent");
  });

  it("a clear refusal is not retried", async () => {
    const { outbox, client, store } = await setup({ postFaults: ["reject_400"] });
    expect((await sendReminder(client, store, request)).state).toBe("failed");
    expect(outbox.postCount).toBe(1);
  });

  it("a second call for a sent key sends nothing", async () => {
    const { outbox, client, store } = await setup();
    await sendReminder(client, store, request);
    expect((await sendReminder(client, store, request)).state).toBe("already_sent");
    expect(outbox.postCount).toBe(1);
  });

  it("an unfinished earlier attempt is read back before anything is sent", async () => {
    const { outbox, client, store } = await setup({
      postFaults: ["apply_then_drop"],
      getFaults: ["drop"],
    });
    await sendReminder(client, store, request); // ends unknown, message applied
    expect((await sendReminder(client, store, request)).state).toBe("sent");
    expect(outbox.postCount).toBe(1);
  });

  it("different content under the same key is a conflict, not a send", async () => {
    const { outbox, client, store } = await setup({ dedupe: true });
    await client.post(request.key, { ...content, body: "Total now due: $500.00 (other wording)" });
    const r = await sendReminder(client, store, request);
    expect(r.state).toBe("conflict");
    expect(outbox.messages).toHaveLength(1);
  });
});

describe("sendReminder ordering", () => {
  it("writes the attempt before the request goes out", async () => {
    const store = new SqliteStore();
    let seenDuringPost: string | undefined;
    const outbox: Outbox = {
      post: async (key) => {
        const rec = await store.getDelivery(key);
        seenDuringPost = `${rec?.state ?? "none"}/${rec?.attempts ?? 0}`;
        return { kind: "uncertain", error: "simulated crash" };
      },
      readback: () => Promise.resolve({ kind: "error", error: "down" }),
    };
    await sendReminder(outbox, store, request);
    expect(seenDuringPost).toBe("sending/1");
  });
});

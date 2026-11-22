import { RULES } from "../config.js";
import { DuplicateDeliveryError, type Store } from "../storage/types.js";
import { contentHash, type OutgoingContent } from "./keys.js";
import type { Outbox, ReadbackResult, StoredMessage } from "./outbox-client.js";

/** Longer than three attempts with their timeouts and readbacks. A "sending" record older than this was left by a crash. */
export const SENDING_LEASE_MS = 120_000;

export type SendState = "sent" | "failed" | "unknown" | "conflict" | "already_sent";

export interface SendResult {
  state: SendState;
  attempts: number;
  outboxRef: string | null;
  note: string;
}

export interface SendRequest {
  key: string;
  contactId: string;
  content: OutgoingContent;
}

function matches(message: StoredMessage, key: string, hash: string): boolean {
  return message.clientRef === key && contentHash(message) === hash;
}

type Verdict =
  | { state: "sent"; ref: string }
  | { state: "conflict" | "unknown"; note: string }
  | { state: "absent" };

/** What a readback tells us. Anything other than "our exact message" or "nothing" stops sending. */
function judgeReadback(rb: ReadbackResult, key: string, hash: string): Verdict {
  if (rb.kind === "error") return { state: "unknown", note: `readback failed: ${rb.error}` };
  if (rb.kind === "not_found") return { state: "absent" };
  const ours = rb.messages.find((m) => matches(m, key, hash));
  if (ours) return { state: "sent", ref: ours.id };
  return { state: "conflict", note: "the outbox holds different content for this key" };
}

/**
 * Sends one approved reminder so that a lost reply can't cause a second message.
 * The record is written before each request goes out; after anything uncertain, the outbox is
 * asked what it holds for the key before anything else happens.
 */
export async function sendReminder(
  outbox: Outbox,
  store: Store,
  request: SendRequest,
  now: () => Date = () => new Date(),
): Promise<SendResult> {
  const { key, content } = request;
  const hash = contentHash(content);
  const existing = await store.getDelivery(key);
  let attempts = existing?.attempts ?? 0;

  const finish = async (
    state: Exclude<SendState, "already_sent">,
    ref: string | null,
    note: string,
  ) => {
    await store.updateDelivery(key, {
      state,
      attempts,
      outboxRef: ref,
      lastError: state === "sent" ? null : note,
    });
    return { state, attempts, outboxRef: ref, note };
  };

  if (existing?.state === "sent") {
    return {
      state: "already_sent",
      attempts,
      outboxRef: existing.outboxRef,
      note: "sent on an earlier run",
    };
  }

  const elsewhere = (note: string): SendResult => ({
    state: "unknown",
    attempts,
    outboxRef: null,
    note,
  });

  if (
    existing?.state === "sending" &&
    now().getTime() - Date.parse(existing.updatedAt) < SENDING_LEASE_MS
  ) {
    // Another process is in the middle of sending this reminder. Leave it alone.
    return elsewhere("another process is sending this reminder; settle it later with reconcile");
  }

  if (existing) {
    // An earlier run didn't finish cleanly. Ask the outbox before doing anything.
    const verdict = judgeReadback(await outbox.readback(key), key, hash);
    if (verdict.state === "sent")
      return finish("sent", verdict.ref, "found by readback of an earlier attempt");
    if (verdict.state !== "absent") return finish(verdict.state, null, verdict.note);
  } else {
    const stamp = now().toISOString();
    try {
      await store.insertDelivery({
        key,
        contactId: request.contactId,
        channel: content.channel,
        recipient: content.to,
        contentHash: hash,
        state: "sending",
        attempts: 0,
        outboxRef: null,
        lastError: null,
        createdAt: stamp,
        updatedAt: stamp,
      });
    } catch (err) {
      // The conditional insert lost a race: another process owns this delivery.
      if (err instanceof DuplicateDeliveryError) {
        return elsewhere("another process started sending this reminder first");
      }
      throw err;
    }
  }

  for (let tries = 1; tries <= RULES.maxSendAttempts; tries++) {
    attempts += 1;
    await store.updateDelivery(key, { state: "sending", attempts });
    const result = await outbox.post(key, content);

    if (result.kind === "accepted") {
      if (matches(result.message, key, hash)) return finish("sent", result.message.id, "accepted");
      return finish("conflict", null, "the outbox echoed different content");
    }
    if (result.kind === "key_conflict")
      return finish("conflict", null, "the outbox refused: key reused with different content");
    if (result.kind === "refused")
      return finish("failed", null, `the outbox refused with ${result.status}`);

    const afterLoss = judgeReadback(await outbox.readback(key), key, hash);
    if (afterLoss.state === "sent")
      return finish("sent", afterLoss.ref, `reply lost (${result.error}), found by readback`);
    if (afterLoss.state !== "absent") return finish(afterLoss.state, null, afterLoss.note);
  }
  return finish("failed", null, `nothing arrived after ${RULES.maxSendAttempts} attempts`);
}

/** Settles an `unknown` delivery later by asking the outbox. Never sends. */
export async function reconcile(outbox: Outbox, store: Store, key: string): Promise<SendResult> {
  const existing = await store.getDelivery(key);
  if (!existing) throw new Error(`no delivery ${key}`);
  if (existing.state === "sent") {
    return {
      state: "already_sent",
      attempts: existing.attempts,
      outboxRef: existing.outboxRef,
      note: "already sent",
    };
  }
  const verdict = judgeReadback(await outbox.readback(key), key, existing.contentHash);
  const state = verdict.state === "absent" ? "failed" : verdict.state;
  const ref = verdict.state === "sent" ? verdict.ref : null;
  const note =
    verdict.state === "sent"
      ? "found by readback"
      : verdict.state === "absent"
        ? "the outbox has nothing for this key"
        : verdict.note;
  await store.updateDelivery(key, {
    state,
    outboxRef: ref,
    lastError: state === "sent" ? null : note,
  });
  return { state, attempts: existing.attempts, outboxRef: ref, note };
}

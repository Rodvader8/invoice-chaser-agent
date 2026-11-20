import { z } from "zod";
import type { OutgoingContent } from "./keys.js";

const Message = z.object({
  id: z.string(),
  clientRef: z.string(),
  channel: z.enum(["email", "sms"]),
  to: z.string(),
  subject: z.string(),
  body: z.string(),
});
export type StoredMessage = z.infer<typeof Message>;

export type PostResult =
  | { kind: "accepted"; message: StoredMessage }
  /** Timeout, dropped connection, 5xx or an unreadable 2xx: it may or may not have been applied. */
  | { kind: "uncertain"; error: string }
  | { kind: "key_conflict" }
  | { kind: "refused"; status: number };

export type ReadbackResult =
  | { kind: "found"; messages: StoredMessage[] }
  | { kind: "not_found" }
  | { kind: "error"; error: string };

export interface Outbox {
  post(key: string, content: OutgoingContent): Promise<PostResult>;
  readback(key: string): Promise<ReadbackResult>;
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : "unknown error";
}

export class OutboxClient implements Outbox {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 5000,
  ) {}

  async post(key: string, content: OutgoingContent): Promise<PostResult> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify(content),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      return { kind: "uncertain", error: describe(err) };
    }
    if (res.status >= 500) return { kind: "uncertain", error: `status ${res.status}` };
    if (res.status === 409) return { kind: "key_conflict" };
    if (res.status >= 400) return { kind: "refused", status: res.status };
    try {
      return { kind: "accepted", message: Message.parse(await res.json()) };
    } catch (err) {
      return { kind: "uncertain", error: `unreadable answer: ${describe(err)}` };
    }
  }

  async readback(key: string): Promise<ReadbackResult> {
    try {
      const res = await fetch(`${this.baseUrl}/messages?clientRef=${encodeURIComponent(key)}`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status !== 200) return { kind: "error", error: `status ${res.status}` };
      const body = z.object({ messages: z.array(Message) }).parse(await res.json());
      return body.messages.length === 0
        ? { kind: "not_found" }
        : { kind: "found", messages: body.messages };
    } catch (err) {
      return { kind: "error", error: describe(err) };
    }
  }
}

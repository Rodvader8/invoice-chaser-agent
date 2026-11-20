import { randomUUID } from "node:crypto";
import { z } from "zod";
import { listen, readBody, sendJson, type RunningServer } from "./http.js";

/**
 * A stand-in mail and SMS gateway, written for this repo, in memory. Each message carries the
 * sender's client reference (the idempotency key) and can be looked up by it.
 *
 * `dedupe: false` (the default) is the harder case: like many real SMS gateways, it stores the
 * reference but doesn't refuse a repeat, so a blind resend delivers twice. Only the sender's
 * readback prevents that. `dedupe: true` treats a repeated key with the same content as the same
 * request and refuses a repeated key with different content (409).
 */

export type PostFault =
  "drop_before_apply" | "apply_then_drop" | "apply_then_503" | "apply_then_stall" | "reject_400";
export type GetFault = "drop" | "error_500";

export interface OutboxMessage {
  id: string;
  clientRef: string;
  channel: "email" | "sms";
  to: string;
  subject: string;
  body: string;
}

const Incoming = z.object({
  channel: z.enum(["email", "sms"]),
  to: z.string().min(1).max(320),
  subject: z.string().max(200),
  body: z.string().min(1).max(5000),
});

export interface OutboxOptions {
  dedupe?: boolean;
  postFaults?: PostFault[];
  getFaults?: GetFault[];
  stallMs?: number;
}

export class OutboxStandIn {
  readonly messages: OutboxMessage[] = [];
  /** Every POST that reached the server, applied or not. */
  postCount = 0;
  private readonly postFaults: PostFault[];
  private readonly getFaults: GetFault[];
  private readonly dedupe: boolean;
  private readonly stallMs: number;

  constructor(options: OutboxOptions = {}) {
    this.dedupe = options.dedupe ?? false;
    this.postFaults = [...(options.postFaults ?? [])];
    this.getFaults = [...(options.getFaults ?? [])];
    this.stallMs = options.stallMs ?? 2000;
  }

  start(port = 0): Promise<RunningServer> {
    return listen(async (req, res, url) => {
      if (req.method === "GET" && url.pathname === "/messages") {
        const fault = this.getFaults.shift();
        if (fault === "drop") return void req.socket.destroy();
        if (fault === "error_500") return sendJson(res, 500, { error: "injected" });
        const ref = url.searchParams.get("clientRef") ?? "";
        return sendJson(res, 200, { messages: this.messages.filter((m) => m.clientRef === ref) });
      }
      if (req.method !== "POST" || url.pathname !== "/messages") return sendJson(res, 404, {});

      this.postCount += 1;
      const fault = this.postFaults.shift();
      if (fault === "drop_before_apply") return void req.socket.destroy();
      if (fault === "reject_400") return sendJson(res, 400, { error: "injected refusal" });

      const clientRef = req.headers["idempotency-key"];
      if (typeof clientRef !== "string" || clientRef.length < 8 || clientRef.length > 128) {
        return sendJson(res, 400, { error: "Idempotency-Key header required" });
      }
      const parsed = Incoming.safeParse(JSON.parse(await readBody(req)));
      if (!parsed.success) return sendJson(res, 400, { error: "bad message" });

      let message = this.dedupe ? this.messages.find((m) => m.clientRef === clientRef) : undefined;
      if (message) {
        const same =
          message.channel === parsed.data.channel &&
          message.to === parsed.data.to &&
          message.subject === parsed.data.subject &&
          message.body === parsed.data.body;
        if (!same) return sendJson(res, 409, { error: "key reused with different content" });
      } else {
        message = { id: randomUUID(), clientRef, ...parsed.data };
        this.messages.push(message);
      }

      if (fault === "apply_then_drop") return void req.socket.destroy();
      if (fault === "apply_then_503") return sendJson(res, 503, { error: "injected" });
      if (fault === "apply_then_stall") {
        const timer = setTimeout(() => {
          sendJson(res, 201, message);
        }, this.stallMs);
        res.on("close", () => {
          clearTimeout(timer);
        });
        return;
      }
      return sendJson(res, 201, message);
    }, port);
  }
}

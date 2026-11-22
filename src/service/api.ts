import { createHash, timingSafeEqual } from "node:crypto";
import { z, ZodError } from "zod";
import { RunStateError, UnknownRunError, type Chaser } from "../chaser.js";
import { listen, readBody, sendJson, type RunningServer } from "../http.js";

const StartInput = z.object({
  asOf: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export const MAX_BODY_BYTES = 65_536;

export interface ApiRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  body: string;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

function digest(text: string): Buffer {
  return createHash("sha256").update(text).digest();
}

/**
 * The routes, independent of the transport. The local HTTP server (startApi) and the Lambda
 * handler (src/lambda/handler.ts) both call this, so they can't drift apart.
 *   GET  /health
 *   POST /runs                    {asOf?}         start a run; drafts come back for approval
 *   GET  /runs/:id                                where a run stands
 *   POST /runs/:id/decisions      {reviewer, decisions: [{contactId, approve, draftHash}]}
 * Every route except /health needs `Authorization: Bearer <token>`. One shared token: there are
 * no user accounts, so the reviewer name is typed in, not authenticated.
 */
export function createRouter(
  chaser: Chaser,
  token: string,
): (req: ApiRequest) => Promise<ApiResponse> {
  if (token.length < 16) throw new Error("API token must be at least 16 characters");
  const expected = digest(`Bearer ${token}`);

  return async (req) => {
    if (req.method === "GET" && req.path === "/health") return { status: 200, body: { ok: true } };
    if (!timingSafeEqual(digest(req.authorization ?? ""), expected)) {
      return { status: 401, body: { error: "unauthorised" } };
    }
    if (Buffer.byteLength(req.body) > MAX_BODY_BYTES)
      return { status: 413, body: { error: "body too large" } };
    try {
      if (req.method === "POST" && req.path === "/runs") {
        const input = StartInput.parse(req.body ? JSON.parse(req.body) : {});
        return { status: 201, body: await chaser.start(input.asOf) };
      }
      const match = /^\/runs\/([0-9a-f-]{36})(\/decisions)?$/.exec(req.path);
      if (match?.[1] && !match[2] && req.method === "GET") {
        return { status: 200, body: await chaser.view(match[1]) };
      }
      if (match?.[1] && match[2] && req.method === "POST") {
        return { status: 200, body: await chaser.decide(match[1], JSON.parse(req.body)) };
      }
      return { status: 404, body: { error: "not found" } };
    } catch (err) {
      if (err instanceof ZodError || err instanceof SyntaxError) {
        return { status: 400, body: { error: "invalid input" } };
      }
      if (err instanceof UnknownRunError) return { status: 404, body: { error: err.message } };
      if (err instanceof RunStateError) return { status: 409, body: { error: err.message } };
      return { status: 500, body: { error: "internal" } };
    }
  };
}

/** The routes on a local HTTP server, bound to 127.0.0.1. */
export async function startApi(
  chaser: Chaser,
  options: { token: string; port?: number },
): Promise<RunningServer> {
  const route = createRouter(chaser, options.token);
  return listen(async (req, res, url) => {
    let body: string;
    try {
      body = req.method === "POST" ? await readBody(req, MAX_BODY_BYTES) : "";
    } catch {
      return sendJson(res, 413, { error: "body too large" });
    }
    const out = await route({
      method: req.method ?? "GET",
      path: url.pathname,
      authorization: req.headers.authorization,
      body,
    });
    sendJson(res, out.status, out.body);
  }, options.port ?? 0);
}

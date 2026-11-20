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

function digest(text: string): Buffer {
  return createHash("sha256").update(text).digest();
}

/**
 * The HTTP API (the shape the planned Lambda function URL would serve):
 *   GET  /health
 *   POST /runs                    {asOf?}         start a run; drafts come back for approval
 *   GET  /runs/:id                                where a run stands
 *   POST /runs/:id/decisions      {reviewer, decisions: [{contactId, approve, draftHash}]}
 * Every route except /health needs `Authorization: Bearer <token>`. One shared token: there are
 * no user accounts, so the reviewer name is typed in, not authenticated.
 */
export async function startApi(
  chaser: Chaser,
  options: { token: string; port?: number },
): Promise<RunningServer> {
  if (options.token.length < 16) throw new Error("API token must be at least 16 characters");
  const expected = digest(`Bearer ${options.token}`);

  return listen(async (req, res, url) => {
    if (req.method === "GET" && url.pathname === "/health") return sendJson(res, 200, { ok: true });
    if (!timingSafeEqual(digest(req.headers.authorization ?? ""), expected)) {
      return sendJson(res, 401, { error: "unauthorised" });
    }
    try {
      if (req.method === "POST" && url.pathname === "/runs") {
        const raw = await readBody(req);
        const input = StartInput.parse(raw ? JSON.parse(raw) : {});
        return sendJson(res, 201, await chaser.start(input.asOf));
      }
      const match = /^\/runs\/([0-9a-f-]{36})(\/decisions)?$/.exec(url.pathname);
      if (match?.[1] && !match[2] && req.method === "GET") {
        return sendJson(res, 200, await chaser.view(match[1]));
      }
      if (match?.[1] && match[2] && req.method === "POST") {
        return sendJson(res, 200, await chaser.decide(match[1], JSON.parse(await readBody(req))));
      }
      return sendJson(res, 404, { error: "not found" });
    } catch (err) {
      if (err instanceof ZodError || err instanceof SyntaxError) {
        return sendJson(res, 400, { error: "invalid input" });
      }
      if (err instanceof UnknownRunError) return sendJson(res, 404, { error: err.message });
      if (err instanceof RunStateError) return sendJson(res, 409, { error: err.message });
      return sendJson(res, 500, { error: "internal" });
    }
  }, options.port ?? 0);
}

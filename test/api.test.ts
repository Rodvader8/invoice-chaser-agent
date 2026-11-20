import { afterEach, describe, expect, it } from "vitest";
import type { RunningServer } from "../src/http.js";
import { startApi } from "../src/service/api.js";
import { startWorld } from "./world.js";

const TOKEN = "test-token-not-secret-0123456789";
let world: Awaited<ReturnType<typeof startWorld>> | null = null;
let api: RunningServer | null = null;
afterEach(async () => {
  await api?.close();
  await world?.close();
  api = null;
  world = null;
});

async function setup() {
  world = await startWorld();
  api = await startApi(world.chaser, { token: TOKEN });
  const call = (path: string, init: RequestInit = {}, token: string | null = TOKEN) =>
    fetch(`${api?.url ?? ""}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
  return call;
}

describe("HTTP API", () => {
  it("needs the token on everything but /health", async () => {
    const call = await setup();
    expect((await call("/health", {}, null)).status).toBe(200);
    expect((await call("/runs", { method: "POST" }, null)).status).toBe(401);
    expect((await call("/runs", { method: "POST" }, "wrong-token-wrong-token")).status).toBe(401);
  });

  it("refuses a short token at start-up", async () => {
    world = await startWorld();
    await expect(startApi(world.chaser, { token: "short" })).rejects.toThrow();
  });

  it("runs start, wait for a decision, then send", async () => {
    const call = await setup();
    const started = (await (
      await call("/runs", { method: "POST", body: JSON.stringify({ asOf: "2026-11-20" }) })
    ).json()) as {
      runId: string;
      status: string;
      drafts: { contactId: string; draftHash: string }[];
    };
    expect(started.status).toBe("awaiting_approval");
    const got = await call(`/runs/${started.runId}`);
    expect(got.status).toBe(200);
    const decisions = started.drafts.map((d) => ({
      contactId: d.contactId,
      approve: true,
      draftHash: d.draftHash,
    }));
    const done = await call(`/runs/${started.runId}/decisions`, {
      method: "POST",
      body: JSON.stringify({ reviewer: "rod", decisions }),
    });
    expect(done.status).toBe(200);
    expect(((await done.json()) as { status: string }).status).toBe("done");
    expect(world?.outbox.messages).toHaveLength(1);
    const again = await call(`/runs/${started.runId}/decisions`, {
      method: "POST",
      body: JSON.stringify({ reviewer: "rod", decisions }),
    });
    expect(again.status).toBe(409);
  });

  it("answers bad input with 400 and unknown runs with 404, without detail", async () => {
    const call = await setup();
    expect((await call("/runs", { method: "POST", body: "{not json" })).status).toBe(400);
    expect(
      (await call("/runs", { method: "POST", body: JSON.stringify({ asOf: "tomorrow" }) })).status,
    ).toBe(400);
    expect((await call("/runs/00000000-0000-0000-0000-000000000000")).status).toBe(404);
  });
});

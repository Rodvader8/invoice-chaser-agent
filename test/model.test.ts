import { describe, expect, it, vi } from "vitest";
import { BUSINESS } from "../src/config.js";
import { draftReminder, parseDraft } from "../src/draft/drafter.js";
import { OpenRouterModel } from "../src/model/openrouter.js";
import { ScriptedModel } from "../src/model/scripted.js";
import { SpendCapError, SpendGuard } from "../src/model/spend.js";
import type { ChatModel, ChatRequest } from "../src/model/types.js";
import { SqliteStore } from "../src/storage/sqlite.js";
import { facts } from "./helpers.js";

const request: ChatRequest = {
  messages: [{ role: "user", content: "x".repeat(3000) }],
  maxTokens: 1000,
  jsonSchema: { name: "reminder", schema: {} },
  purpose: "test",
};

function okResponse(cost?: number) {
  return new Response(
    JSON.stringify({
      model: "test/model",
      choices: [{ message: { content: '{"subject":"s","body":"b"}' } }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 50,
        ...(cost === undefined ? {} : { cost }),
      },
    }),
    { status: 200 },
  );
}

function model(guard: SpendGuard, fetchImpl: typeof fetch) {
  // $1 per million tokens in and out: this request's worst case is (1000 + 1000) / 1e6 = $0.002.
  return new OpenRouterModel({
    apiKey: "test-not-a-key",
    model: "test/model",
    priceInPerMTok: 1,
    priceOutPerMTok: 1,
    guard,
    fetchImpl,
  });
}

describe("spend guard and OpenRouter client (no network: fetch is faked)", () => {
  it("refuses before calling when the run cap would be exceeded", async () => {
    const store = new SqliteStore();
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(okResponse(0.0015)));
    const m = model(new SpendGuard({ runCapUsd: 0.003, projectCapUsd: 1 }, store), fetchImpl);
    await m.complete(request);
    await expect(m.complete(request)).rejects.toBeInstanceOf(SpendCapError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await store.totalSpendUsd()).toBeCloseTo(0.0015, 10);
  });

  it("the project cap holds across runs because spend is stored", async () => {
    const store = new SqliteStore();
    await store.addSpend(0.999, "earlier", "earlier run");
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(okResponse()));
    const m = model(new SpendGuard({ runCapUsd: 1, projectCapUsd: 1 }, store), fetchImpl);
    await expect(m.complete(request)).rejects.toThrow(/project cap/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses when the account balance would fall below the floor", async () => {
    const guard = new SpendGuard(
      { runCapUsd: 1, projectCapUsd: 1, accountFloorUsd: 2 },
      new SqliteStore(),
      () => Promise.resolve(2.001),
    );
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(okResponse()));
    await expect(model(guard, fetchImpl).complete(request)).rejects.toThrow(/balance/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends the schema and key, and records the reported cost", async () => {
    const store = new SqliteStore();
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(okResponse(0.0004)));
    const r = await model(
      new SpendGuard({ runCapUsd: 1, projectCapUsd: 1 }, store),
      fetchImpl,
    ).complete(request);
    expect(r.costUsd).toBe(0.0004);
    const init = fetchImpl.mock.calls[0]?.[1];
    const body = JSON.parse(init?.body as string) as {
      response_format: { type: string };
      max_tokens: number;
    };
    expect(body.response_format.type).toBe("json_schema");
    expect(body.max_tokens).toBe(1000);
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer test-not-a-key");
  });

  it("charges the worst-case estimate when a call fails after being sent, and nothing for a 4xx", async () => {
    const store = new SqliteStore();
    const guard = new SpendGuard({ runCapUsd: 1, projectCapUsd: 1 }, store);
    await expect(
      model(guard, () => Promise.resolve(new Response("", { status: 502 }))).complete(request),
    ).rejects.toThrow();
    expect(await store.totalSpendUsd()).toBeCloseTo(0.002, 10);
    await expect(
      model(guard, () => Promise.resolve(new Response("", { status: 401 }))).complete(request),
    ).rejects.toThrow();
    expect(await store.totalSpendUsd()).toBeCloseTo(0.002, 10);
  });

  it("won't start without prices or a key", () => {
    const guard = new SpendGuard({ runCapUsd: 1, projectCapUsd: 1 }, new SqliteStore());
    expect(
      () =>
        new OpenRouterModel({
          apiKey: "",
          model: "m",
          priceInPerMTok: 1,
          priceOutPerMTok: 1,
          guard,
        }),
    ).toThrow();
    expect(
      () =>
        new OpenRouterModel({
          apiKey: "k",
          model: "m",
          priceInPerMTok: 0,
          priceOutPerMTok: 1,
          guard,
        }),
    ).toThrow();
  });
});

describe("drafter", () => {
  it("accepts fenced JSON and refuses other shapes", () => {
    expect(parseDraft('```json\n{"subject":"a","body":"b"}\n```')).toEqual({
      subject: "a",
      body: "b",
    });
    expect(parseDraft("not json")).toBe("the answer wasn't valid JSON");
    expect(parseDraft('{"text":"b"}')).toBe("the answer didn't match the {subject, body} shape");
  });

  it("retries once with the failed checks fed back, then holds", async () => {
    const seen: string[] = [];
    const bad: ChatModel = {
      name: "bad",
      complete: (req) => {
        seen.push(req.messages.at(-1)?.content ?? "");
        return Promise.resolve({
          text: '{"subject":"Hi","body":"You owe $1.00 on INV-1001"}',
          model: "bad",
          promptTokens: 0,
          completionTokens: 0,
          costUsd: 0,
        });
      },
    };
    const result = await draftReminder(bad, facts(), BUSINESS);
    expect(result.ok).toBe(false);
    expect(result.attempts).toHaveLength(2);
    expect(seen[1]).toContain("Your previous draft failed these checks");
    expect(seen[1]).toContain("$1.00");
  });

  it("the scripted model's faithful draft passes first time", async () => {
    const result = await draftReminder(new ScriptedModel("faithful"), facts(), BUSINESS);
    expect(result.ok).toBe(true);
    expect(result.attempts).toHaveLength(1);
  });
});

import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SSMClient } from "@aws-sdk/client-ssm";
import type { LambdaFunctionURLEvent } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import { createHandler } from "../src/lambda/handler.js";
import { buildRuntime } from "../src/lambda/runtime.js";
import { SsmSecretSource, type SecretSource } from "../src/lambda/secrets.js";
import { ScriptedModel } from "../src/model/scripted.js";
import { DynamoDbMessageLog } from "../src/standins/dynamodb-log.js";
import type { MessageLog, OutboxMessage } from "../src/standins/outbox.js";
import { DynamoDbCheckpointKv, KvCheckpointSaver } from "../src/storage/checkpoint.js";
import { SqliteCheckpointKv } from "../src/storage/checkpoint-sqlite.js";
import { DynamoDbStore } from "../src/storage/dynamodb.js";
import { SqliteStore } from "../src/storage/sqlite.js";
import { dynamoAvailable, dynamoLabel, freshTable, localDoc } from "./dynamo.js";

const TOKEN = "test-token-not-secret-0123456789";
const sample = JSON.parse(
  readFileSync(new URL("./fixtures/function-url-event.json", import.meta.url), "utf8"),
) as LambdaFunctionURLEvent;

function event(
  method: string,
  path: string,
  options: { body?: unknown; token?: string | null; base64?: boolean } = {},
): LambdaFunctionURLEvent {
  const raw = options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers = { ...sample.headers } as Record<string, string>;
  delete headers.authorization;
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? TOKEN}`;
  const { body: _sampleBody, ...rest } = sample;
  return {
    ...rest,
    rawPath: path,
    headers,
    requestContext: {
      ...sample.requestContext,
      http: { ...sample.requestContext.http, method, path },
    },
    isBase64Encoded: Boolean(options.base64),
    ...(raw === undefined
      ? {}
      : { body: options.base64 ? Buffer.from(raw).toString("base64") : raw }),
  };
}

function fakeSecrets() {
  const load = vi.fn(() => Promise.resolve({ openrouterKey: "test-not-a-key", apiToken: TOKEN }));
  const source: SecretSource = { load };
  return { source, load };
}

class ArrayLog implements MessageLog {
  readonly messages: OutboxMessage[] = [];
  append(m: OutboxMessage) {
    this.messages.push(m);
    return Promise.resolve();
  }
  byRef(ref: string) {
    return Promise.resolve(this.messages.filter((m) => m.clientRef === ref));
  }
}

/** A "container": a handler with its own runtime, on persistent SQLite state at `path`. */
function sqliteContainer(
  path: string,
  log: MessageLog,
  secrets = fakeSecrets(),
  logs: string[] = [],
) {
  const handler = createHandler({
    secrets,
    runtime: (s) =>
      buildRuntime({
        store: new SqliteStore(path),
        checkpointer: new KvCheckpointSaver(new SqliteCheckpointKv(path)),
        messageLog: log,
        model: new ScriptedModel("faithful"),
        apiToken: s.apiToken,
      }),
    log: (l) => logs.push(l),
  });
  return { handler, secrets, logs };
}

const parse = (body: string | undefined) =>
  JSON.parse(body ?? "null") as Record<string, unknown> & {
    runId: string;
    status: string;
    drafts: { contactId: string; draftHash: string }[];
    outcomes: { contactId: string; delivery?: string }[];
  };

const tempDb = () => join(mkdtempSync(join(tmpdir(), "chaser-lambda-")), "state.db");

describe("Lambda handler (function URL events, no AWS)", () => {
  it("maps the sample function URL event (base64 body) to POST /runs", async () => {
    const { handler } = sqliteContainer(tempDb(), new ArrayLog());
    const res = await handler({
      ...sample,
      headers: { ...sample.headers, authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(parse(res.body).status).toBe("awaiting_approval");
  });

  it("reads the secrets once per cold start", async () => {
    const { handler, secrets } = sqliteContainer(tempDb(), new ArrayLog());
    await handler(event("GET", "/health"));
    await handler(event("POST", "/runs", { body: { asOf: "2026-11-20" } }));
    await handler(event("GET", "/health"));
    expect(secrets.load).toHaveBeenCalledTimes(1);
  });

  it("answers 503 if the cold start fails, and tries again on the next request", async () => {
    const secrets = fakeSecrets();
    secrets.load.mockRejectedValueOnce(new Error("ssm unreachable"));
    const { handler, logs } = sqliteContainer(tempDb(), new ArrayLog(), secrets);
    expect((await handler(event("GET", "/health"))).statusCode).toBe(503);
    expect((await handler(event("GET", "/health"))).statusCode).toBe(200);
    expect(secrets.load).toHaveBeenCalledTimes(2);
    expect(logs.join("\n")).not.toContain("ssm unreachable");
  });

  it("keeps the router's auth and errors, and logs no token or body", async () => {
    const { handler, logs } = sqliteContainer(tempDb(), new ArrayLog());
    expect((await handler(event("POST", "/runs", { token: null }))).statusCode).toBe(401);
    expect(
      (await handler(event("POST", "/runs", { token: "wrong-token-wrong-token" }))).statusCode,
    ).toBe(401);
    expect((await handler(event("POST", "/runs", { body: { asOf: "tomorrow" } }))).statusCode).toBe(
      400,
    );
    expect(
      (await handler(event("GET", "/runs/00000000-0000-0000-0000-000000000000"))).statusCode,
    ).toBe(404);
    expect(
      (await handler(event("POST", "/runs", { body: { pad: "x".repeat(70_000) } }))).statusCode,
    ).toBe(413);
    expect((await handler(event("GET", "/elsewhere"))).statusCode).toBe(404);
    const text = logs.join("\n");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("tomorrow");
    expect(
      logs.every((l) =>
        Object.keys(JSON.parse(l) as object).every((k) =>
          ["method", "path", "status", "ms"].includes(k),
        ),
      ),
    ).toBe(true);
  });

  it("approve after a cold start: one container starts the run, a fresh one approves and sends", async () => {
    const path = tempDb();
    const log = new ArrayLog();
    const first = sqliteContainer(path, log);
    const started = parse(
      (await first.handler(event("POST", "/runs", { body: { asOf: "2026-11-20" }, base64: true })))
        .body,
    );
    expect(started.status).toBe("awaiting_approval");

    const second = sqliteContainer(path, log);
    const decisions = started.drafts.map((d) => ({
      contactId: d.contactId,
      approve: true,
      draftHash: d.draftHash,
    }));
    const res = await second.handler(
      event("POST", `/runs/${started.runId}/decisions`, { body: { reviewer: "rod", decisions } }),
    );
    expect(res.statusCode).toBe(200);
    const done = parse(res.body);
    expect(done.status).toBe("done");
    expect(done.outcomes.filter((o) => o.delivery === "sent")).toHaveLength(started.drafts.length);
    expect(log.messages).toHaveLength(started.drafts.length);
    const again = await first.handler(
      event("POST", `/runs/${started.runId}/decisions`, { body: { reviewer: "rod", decisions } }),
    );
    expect(again.statusCode).toBe(409);
    expect(log.messages).toHaveLength(started.drafts.length);
  });
});

describe("SsmSecretSource (a fake SSM client; no AWS call)", () => {
  it("asks for both parameters, decrypted, in one call", async () => {
    const send = vi.fn(() =>
      Promise.resolve({
        Parameters: [
          { Name: "/k", Value: "test-value-a" },
          { Name: "/t", Value: "test-value-b" },
        ],
        InvalidParameters: [],
      }),
    );
    const source = new SsmSecretSource({ send } as unknown as SSMClient, {
      openrouterKey: "/k",
      apiToken: "/t",
    });
    expect(await source.load()).toEqual({
      openrouterKey: "test-value-a",
      apiToken: "test-value-b",
    });
    const input = (
      send.mock.calls[0] as unknown as [{ input: { Names: string[]; WithDecryption: boolean } }]
    )[0].input;
    expect(input).toEqual({ Names: ["/k", "/t"], WithDecryption: true });
  });

  it("fails clearly, naming only the parameter, when one is missing or unset", async () => {
    const send = vi.fn(() => Promise.resolve({ Parameters: [], InvalidParameters: ["/t"] }));
    await expect(
      new SsmSecretSource({ send } as unknown as SSMClient, {
        openrouterKey: "/k",
        apiToken: "/t",
      }).load(),
    ).rejects.toThrow("missing parameters: /t");
    await expect(
      new SsmSecretSource({ send } as unknown as SSMClient, {
        openrouterKey: undefined,
        apiToken: "/t",
      }).load(),
    ).rejects.toThrow(/OPENROUTER_KEY_PARAM/);
  });
});

describe.skipIf(!dynamoAvailable)(dynamoLabel("Lambda handler on DynamoDB"), () => {
  it("approve after a cold start with every piece of state in the one table", async () => {
    const table = await freshTable();
    const container = () =>
      createHandler({
        secrets: fakeSecrets().source,
        runtime: (s) => {
          const doc = localDoc();
          return buildRuntime({
            store: new DynamoDbStore(doc, table),
            checkpointer: new KvCheckpointSaver(new DynamoDbCheckpointKv(doc, table)),
            messageLog: new DynamoDbMessageLog(doc, table),
            model: new ScriptedModel("faithful"),
            apiToken: s.apiToken,
          });
        },
        log: () => undefined,
      });
    const started = parse(
      (await container()(event("POST", "/runs", { body: { asOf: "2026-11-20" } }))).body,
    );
    expect(started.status).toBe("awaiting_approval");
    const decisions = started.drafts.map((d) => ({
      contactId: d.contactId,
      approve: true,
      draftHash: d.draftHash,
    }));
    const done = parse(
      (
        await container()(
          event("POST", `/runs/${started.runId}/decisions`, {
            body: { reviewer: "rod", decisions },
          }),
        )
      ).body,
    );
    expect(done.status).toBe("done");
    expect(done.outcomes.filter((o) => o.delivery === "sent")).toHaveLength(started.drafts.length);
    const log = new DynamoDbMessageLog(localDoc(), table);
    const store = new DynamoDbStore(localDoc(), table);
    const deliveries = await store.listDeliveries();
    expect(deliveries).toHaveLength(started.drafts.length);
    for (const d of deliveries) expect(await log.byRef(d.key)).toHaveLength(1);
    expect((await store.listAudit(started.runId)).some((e) => e.type === "send_result")).toBe(true);
  });
});

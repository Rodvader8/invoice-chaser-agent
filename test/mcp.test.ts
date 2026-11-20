import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { buildMcpServer } from "../src/mcp/server.js";
import { startWorld, WORLD } from "./world.js";

let world: Awaited<ReturnType<typeof startWorld>> | null = null;
afterEach(async () => {
  await world?.close();
  world = null;
});

async function connect() {
  world = await startWorld();
  const logs: string[] = [];
  const server = buildMcpServer({
    accounting: world.accounting,
    jobs: world.jobs,
    now: () => new Date("2026-11-20T00:00:00+11:00"),
    log: (l) => logs.push(l),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0.0.1" });
  await client.connect(b);
  return { client, logs };
}

function text(result: unknown): string {
  const content = (result as { content: { text: string }[] }).content;
  return content.map((c) => c.text).join("\n");
}

describe("MCP server", () => {
  it("offers only read-only tools", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_invoice",
      "get_job",
      "list_customers_to_chase",
    ]);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.annotations?.destructiveHint).toBe(false);
    }
  });

  it("returns the same figures the agent computes, and no contact details", async () => {
    const { client } = await connect();
    const out = text(
      await client.callTool({ name: "list_customers_to_chase", arguments: { asOf: "2026-11-20" } }),
    );
    expect(out).toContain('"totalRequested": "$500.00"');
    expect(out).toContain('"reason": "dispute_open"');
    for (const c of WORLD.contacts) expect(out).not.toContain(c.EmailAddress ?? "@");
  });

  it("labels notes as untrusted and validates inputs", async () => {
    const { client, logs } = await connect();
    const inv = text(
      await client.callTool({
        name: "get_invoice",
        arguments: { invoiceNumber: "INV-5001", asOf: "2026-11-20" },
      }),
    );
    expect(inv).toContain("untrusted_notes");
    expect(inv).toContain('"daysOverdue": 19');
    const bad = await client.callTool({
      name: "get_invoice",
      arguments: { invoiceNumber: "DROP TABLE" },
    });
    expect(bad.isError).toBe(true);
    const missing = await client.callTool({ name: "get_job", arguments: { jobNumber: "123" } });
    expect(missing.isError).toBe(true);
    expect(logs.every((l) => !l.includes("INV-5001") && !l.includes("123"))).toBe(true);
  });
});

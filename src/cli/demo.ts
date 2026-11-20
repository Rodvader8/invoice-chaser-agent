import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { Chaser } from "../chaser.js";
import { formatCents } from "../money.js";
import { SqliteStore } from "../storage/sqlite.js";
import { connect, makeModel } from "./common.js";

/**
 * One run against the invented seed data, in the terminal.
 *   npm run demo                      scripted model, asks you about each draft
 *   npm run demo -- --approve-all     approve everything without asking
 *   npm run demo -- --live            a real model through OpenRouter (costs money; see README)
 */
const { values } = parseArgs({
  options: {
    "as-of": { type: "string" },
    "approve-all": { type: "boolean", default: false },
    "reject-all": { type: "boolean", default: false },
    live: { type: "boolean", default: false },
    db: { type: "string", default: ":memory:" },
  },
});

const conn = await connect();
const store = new SqliteStore(values.db);
try {
  const chaser = new Chaser({
    accounting: conn.accounting,
    jobs: conn.jobs,
    outbox: conn.outbox,
    model: makeModel(store, values.live),
    store,
  });
  const asOf = values["as-of"] ?? conn.seedAsOf;
  let view = await chaser.start(asOf);
  console.log(`Run ${view.runId}, as of ${asOf}\n`);

  for (const o of view.outcomes) {
    console.log(
      `${o.action.toUpperCase().padEnd(5)} ${o.customerName}: ${o.reason ?? ""}${o.note ? ` (${o.note})` : ""}`,
    );
  }

  if (view.status === "awaiting_approval") {
    const rl =
      process.stdin.isTTY && !values["approve-all"] && !values["reject-all"]
        ? createInterface({ input: process.stdin, output: process.stdout })
        : null;
    if (!rl && !values["approve-all"] && !values["reject-all"]) {
      console.log("\nNot a terminal and no --approve-all: rejecting every draft.");
    }
    const decisions = [];
    for (const d of view.drafts) {
      console.log(
        `\n=== Draft for ${d.customerName} by ${d.content.channel} to ${d.content.to} (${d.facts.stage}, total ${formatCents(d.facts.totalRequestedCents)}) ===`,
      );
      if (d.content.subject) console.log(`Subject: ${d.content.subject}`);
      console.log(d.content.body);
      let approve = values["approve-all"];
      if (rl)
        approve = (await rl.question("Approve and send? [y/N] ")).trim().toLowerCase() === "y";
      decisions.push({ contactId: d.contactId, approve, draftHash: d.draftHash });
    }
    rl?.close();
    view = await chaser.decide(view.runId, { reviewer: process.env.USER ?? "demo", decisions });
  }

  console.log("\nOutcomes:");
  for (const o of view.outcomes) {
    const what = o.delivery ?? o.reason ?? o.action;
    console.log(`  ${o.customerName.padEnd(26)} ${o.action.padEnd(5)} ${what}`);
  }
  if (conn.outboxStandIn)
    console.log(`\nMessages at the stand-in outbox: ${conn.outboxStandIn.messages.length}`);
  console.log(`Audit events recorded: ${(await store.listAudit(view.runId)).length}`);
} finally {
  store.close();
  await conn.close();
}

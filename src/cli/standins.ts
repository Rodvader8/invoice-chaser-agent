import { connect } from "./common.js";

/** Runs the three stand-ins with the invented seed data, for the API or an MCP client to use. */
const base = Number(process.env.STANDIN_BASE_PORT ?? 4101);
const conn = await connect([base, base + 1, base + 2]);
console.log("Stand-ins running with invented seed data. Point the service at them with:");
console.log(`ACCOUNTING_URL=http://127.0.0.1:${base}`);
console.log(`JOBS_URL=http://127.0.0.1:${base + 1}`);
console.log(`OUTBOX_URL=http://127.0.0.1:${base + 2}`);
process.on("SIGINT", () => void conn.close().then(() => process.exit(0)));

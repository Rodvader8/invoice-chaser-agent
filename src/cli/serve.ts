import { Chaser } from "../chaser.js";
import { startApi } from "../service/api.js";
import { SqliteStore } from "../storage/sqlite.js";
import { connect, makeModel } from "./common.js";

/**
 * The HTTP API on 127.0.0.1. Needs INVOICE_CHASER_API_TOKEN (16+ characters).
 * INVOICE_CHASER_PORT (default 8787), INVOICE_CHASER_DB (default invoice-chaser.db),
 * INVOICE_CHASER_LIVE=1 for a real model (costs money).
 */
const token = process.env.INVOICE_CHASER_API_TOKEN ?? "";
if (token.length < 16) {
  console.error("Set INVOICE_CHASER_API_TOKEN to a random string of 16+ characters.");
  process.exit(1);
}
const conn = await connect();
const store = new SqliteStore(process.env.INVOICE_CHASER_DB ?? "invoice-chaser.db");
const chaser = new Chaser({
  accounting: conn.accounting,
  jobs: conn.jobs,
  outbox: conn.outbox,
  model: makeModel(store, process.env.INVOICE_CHASER_LIVE === "1"),
  store,
});
const api = await startApi(chaser, {
  token,
  port: Number(process.env.INVOICE_CHASER_PORT ?? 8787),
});
console.log(`Invoice chaser API on ${api.url} (stand-in data as of ${conn.seedAsOf})`);

const stop = () => {
  void api
    .close()
    .then(() => conn.close())
    .finally(() => {
      store.close();
      process.exit(0);
    });
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

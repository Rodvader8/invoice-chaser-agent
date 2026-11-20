/**
 * The planned DynamoDB store, for the AWS stage. NOT BUILT: this file only records the design so
 * the Store interface in ./types.ts can be checked against it. See AWS_PLAN.md.
 *
 * One table, provisioned capacity (well under the 25 read and 25 write units of the free tier),
 * partition key `pk`, sort key `sk`:
 *
 * | item            | pk                     | sk                         | notes                                   |
 * |-----------------|------------------------|----------------------------|-----------------------------------------|
 * | delivery        | `DELIVERY#<key>`       | `DELIVERY`                 | insert with attribute_not_exists(pk)    |
 * | audit event     | `RUN#<runId>`          | `AUDIT#<iso time>#<seq>`   | append only                             |
 * | spend total     | `SPEND`                | `TOTAL`                    | atomic ADD on `usd`                     |
 *
 * insertDelivery maps to a conditional PutItem (attribute_not_exists), which gives the same
 * "one record per key" guarantee as the SQLite primary key. updateDelivery maps to UpdateItem.
 * listAudit without a run id would need a scan; the Lambda version would only list by run.
 */
import type { Store } from "./types.js";

export type DynamoDbStore = Store;

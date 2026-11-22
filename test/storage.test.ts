import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DynamoDbMessageLog } from "../src/standins/dynamodb-log.js";
import { DynamoDbStore } from "../src/storage/dynamodb.js";
import { SqliteStore } from "../src/storage/sqlite.js";
import { dynamoAvailable, dynamoLabel, freshTable, localDoc } from "./dynamo.js";
import { storeContract } from "./store-contract.js";

let sqlitePath = "";
storeContract("SqliteStore", {
  open: () => {
    sqlitePath = join(mkdtempSync(join(tmpdir(), "chaser-store-")), "test.db");
    return Promise.resolve(new SqliteStore(sqlitePath));
  },
  reopen: () => Promise.resolve(new SqliteStore(sqlitePath)),
});

let table = "";
storeContract(
  dynamoLabel("DynamoDbStore"),
  {
    open: async () => {
      table = await freshTable();
      return new DynamoDbStore(localDoc(), table);
    },
    reopen: () => Promise.resolve(new DynamoDbStore(localDoc(), table)),
    messageLog: () => new DynamoDbMessageLog(localDoc(), table),
  },
  dynamoAvailable,
);

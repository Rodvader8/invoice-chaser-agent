import { randomUUID } from "node:crypto";
import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { createTable, documentClient } from "../src/storage/dynamodb.js";

/**
 * DynamoDB Local (the amazon/dynamodb-local Docker image) for tests. If nothing answers at the
 * endpoint, the DynamoDB tests are skipped and say so in their names; with REQUIRE_DYNAMODB=1
 * (the CI job) an unreachable endpoint is an error instead of a skip.
 * The credentials are placeholders DynamoDB Local requires; no AWS account is involved.
 */
export const DYNAMODB_ENDPOINT = process.env.DYNAMODB_ENDPOINT ?? "http://127.0.0.1:8000";

const localConfig = {
  endpoint: DYNAMODB_ENDPOINT,
  region: "ap-southeast-2",
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
  maxAttempts: 1,
};

async function probe(): Promise<boolean> {
  try {
    await new DynamoDBClient(localConfig).send(new ListTablesCommand({}), {
      abortSignal: AbortSignal.timeout(1500),
    });
    return true;
  } catch {
    return false;
  }
}

const required = process.env.REQUIRE_DYNAMODB === "1";

/** Required: wait up to 20 seconds (a fresh container takes a moment to listen). Otherwise: one quick check. */
async function waitForDynamo(): Promise<boolean> {
  const deadline = Date.now() + (required ? 20_000 : 0);
  for (;;) {
    if (await probe()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export const dynamoAvailable = await waitForDynamo();
if (!dynamoAvailable && required) {
  throw new Error(
    `REQUIRE_DYNAMODB=1 but nothing answered at ${DYNAMODB_ENDPOINT} within 20 seconds`,
  );
}

export function dynamoLabel(name: string): string {
  return dynamoAvailable
    ? `DynamoDB Local: ${name}`
    : `DynamoDB Local: ${name} (SKIPPED: nothing at ${DYNAMODB_ENDPOINT}; run npm run dynamodb:start)`;
}

export function localDoc() {
  return documentClient(localConfig);
}

/** A fresh table, shaped like the CDK one, so tests don't see each other's items. */
export async function freshTable(): Promise<string> {
  const name = `test_${randomUUID()}`;
  await createTable(localDoc(), name);
  return name;
}

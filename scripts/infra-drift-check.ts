import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Proves the CDK guardrail tests can fail: changes infra/lib/stack.ts one guardrail at a time,
 * runs test/infra.test.ts, and requires it to fail. The file is always restored. A drift the
 * tests miss, or a drift that no longer matches the stack, fails this script.
 */
const DRIFTS: [string, string, string][] = [
  ["memory 1024 MB", "memorySize: 512,", "memorySize: 1024,"],
  ["x86_64 instead of arm64", "lambda.Architecture.ARM_64", "lambda.Architecture.X86_64"],
  ["no reserved concurrency", "      reservedConcurrentExecutions: 2,\n", ""],
  [
    "on-demand table",
    "billingMode: dynamodb.BillingMode.PROVISIONED,\n      readCapacity: 5,\n      writeCapacity: 5,",
    "billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,",
  ],
  [
    "autoscaling added",
    "    const logGroup = new logs.LogGroup",
    "    table.autoScaleReadCapacity({ minCapacity: 5, maxCapacity: 50 }).scaleOnUtilization({ targetUtilizationPercent: 70 });\n    const logGroup = new logs.LogGroup",
  ],
  ["logs kept a month", "logs.RetentionDays.ONE_WEEK", "logs.RetentionDays.ONE_MONTH"],
  [
    "table retained on destroy",
    "      removalPolicy: RemovalPolicy.DESTROY,\n    });\n\n    const logGroup",
    "      removalPolicy: RemovalPolicy.RETAIN,\n    });\n\n    const logGroup",
  ],
  ["SSM wildcard", "resourceName: name.slice(1),", 'resourceName: "invoice-chaser/*",'],
  ["IAM auth on the URL", "FunctionUrlAuthType.NONE", "FunctionUrlAuthType.AWS_IAM"],
];

const root = resolve(import.meta.dirname, "..");
const file = join(root, "infra", "lib", "stack.ts");
const original = readFileSync(file, "utf8");

function testsPass(): boolean {
  try {
    execFileSync(join(root, "node_modules", ".bin", "vitest"), ["run", "test/infra.test.ts"], {
      cwd: root,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

let ok = testsPass();
console.log(`control (no change): guardrail tests ${ok ? "pass" : "FAIL"}`);
try {
  for (const [name, search, replace] of DRIFTS) {
    const count = original.split(search).length - 1;
    if (count !== 1) {
      console.log(`OUT OF DATE  ${name}: matches the stack ${count} times`);
      ok = false;
      continue;
    }
    writeFileSync(file, original.replace(search, replace));
    const caught = !testsPass();
    writeFileSync(file, original);
    console.log(`${caught ? "CAUGHT" : "MISSED"}  ${name}`);
    if (!caught) ok = false;
  }
} finally {
  writeFileSync(file, original);
}
console.log(ok ? "\nInfra drift check: every drift was caught." : "\nInfra drift check FAILED.");
process.exitCode = ok ? 0 : 1;

import { join } from "node:path";
import {
  ArnFormat,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  Tags,
  type StackProps,
} from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";

/** The two SecureString parameters Rod creates by hand. The stack only references their names. */
export const PARAMETER_NAMES = {
  openrouterKey: "/invoice-chaser/openrouter-key",
  apiToken: "/invoice-chaser/api-token",
} as const;

const ROOT = join(import.meta.dirname, "..", "..");

/**
 * The whole AWS footprint (AWS_PLAN.md): one function behind a function URL, one table, one log
 * group, and read access to two parameters. Every guardrail here is pinned by a test in
 * test/infra.test.ts, so changing one fails the build.
 */
export class InvoiceChaserStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    const table = new dynamodb.Table(this, "Table", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity: 5,
      writeCapacity: 5,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const logGroup = new logs.LogGroup(this, "Logs", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const fn = new NodejsFunction(this, "Function", {
      entry: join(ROOT, "src", "lambda", "handler.ts"),
      handler: "handler",
      projectRoot: ROOT,
      depsLockFilePath: join(ROOT, "package-lock.json"),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(30),
      reservedConcurrentExecutions: 2,
      logGroup,
      environment: {
        TABLE_NAME: table.tableName,
        OPENROUTER_KEY_PARAM: PARAMETER_NAMES.openrouterKey,
        API_TOKEN_PARAM: PARAMETER_NAMES.apiToken,
        INVOICE_CHASER_LIVE: "0",
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        format: OutputFormat.ESM,
        target: "node24",
        mainFields: ["module", "main"],
        externalModules: [],
        sourceMap: true,
        forceDockerBundling: false,
        banner:
          "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
    });

    table.grantReadWriteData(fn);
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameters"],
        resources: Object.values(PARAMETER_NAMES).map((name) =>
          this.formatArn({
            service: "ssm",
            resource: "parameter",
            resourceName: name.slice(1),
            arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
          }),
        ),
      }),
    );

    const url = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

    Tags.of(this).add("project", "invoice-chaser");
    new CfnOutput(this, "FunctionUrl", { value: url.url });
    new CfnOutput(this, "TableName", { value: table.tableName });
  }
}

import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { InvoiceChaserStack } from "../infra/lib/stack.js";

/**
 * The guardrails from AWS_PLAN.md, pinned. Each expected value is written out here, not
 * imported from the stack, so changing the stack can't quietly change the test with it.
 * Bundling is skipped (it's exercised by `npm run cdk:synth`), so this needs no Docker,
 * no network and no AWS credentials.
 */
const app = new App({ context: { "aws:cdk:bundling-stacks": [] } });
const stack = new InvoiceChaserStack(app, "InvoiceChaser", { env: { region: "ap-southeast-2" } });
const template = Template.fromStack(stack);
const resources = template.toJSON().Resources as Record<
  string,
  { Type: string; Properties?: Record<string, unknown> }
>;

describe("CDK stack guardrails", () => {
  it("is in Sydney", () => {
    expect(stack.region).toBe("ap-southeast-2");
  });

  it("has exactly the planned resources, and nothing hidden (no custom resources, no autoscaling)", () => {
    const counts: Record<string, number> = {};
    for (const r of Object.values(resources)) counts[r.Type] = (counts[r.Type] ?? 0) + 1;
    expect(counts).toEqual({
      "AWS::DynamoDB::Table": 1,
      "AWS::Logs::LogGroup": 1,
      "AWS::IAM::Role": 1,
      "AWS::IAM::Policy": 1,
      "AWS::Lambda::Function": 1,
      "AWS::Lambda::Url": 1,
      "AWS::Lambda::Permission": 2,
    });
  });

  it("runs one function: Node 24, arm64, 512 MB, 30 seconds, reserved concurrency 2", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs24.x",
      Architectures: ["arm64"],
      MemorySize: 512,
      Timeout: 30,
      ReservedConcurrentExecutions: 2,
    });
  });

  it("puts parameter names, never secret values, in the environment", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: {
          TABLE_NAME: Match.anyValue(),
          OPENROUTER_KEY_PARAM: "/invoice-chaser/openrouter-key",
          API_TOKEN_PARAM: "/invoice-chaser/api-token",
          INVOICE_CHASER_LIVE: "0",
          NODE_OPTIONS: "--enable-source-maps",
        },
      },
    });
  });

  it("serves it through a function URL with the token check in code", () => {
    template.hasResourceProperties("AWS::Lambda::Url", { AuthType: "NONE" });
  });

  it("has one table at fixed 5/5 provisioned capacity, deleted with the stack", () => {
    template.hasResource("AWS::DynamoDB::Table", {
      DeletionPolicy: "Delete",
      UpdateReplacePolicy: "Delete",
      Properties: Match.objectLike({
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false },
      }),
    });
    const table = Object.values(resources).find((r) => r.Type === "AWS::DynamoDB::Table");
    expect(table?.Properties?.BillingMode).not.toBe("PAY_PER_REQUEST");
    expect(table?.Properties?.GlobalSecondaryIndexes).toBeUndefined();
    template.resourceCountIs("AWS::ApplicationAutoScaling::ScalableTarget", 0);
    template.resourceCountIs("AWS::ApplicationAutoScaling::ScalingPolicy", 0);
  });

  it("keeps logs for 7 days and deletes them with the stack", () => {
    template.hasResource("AWS::Logs::LogGroup", {
      DeletionPolicy: "Delete",
      Properties: { RetentionInDays: 7 },
    });
  });

  it("lets the function read only the two parameters, and nothing else from SSM, Secrets Manager or KMS", () => {
    const statements = Object.values(resources)
      .filter((r) => r.Type === "AWS::IAM::Policy")
      .flatMap(
        (r) =>
          (
            r.Properties?.PolicyDocument as {
              Statement: { Action: string | string[]; Resource: unknown }[];
            }
          ).Statement,
      );
    const ssm = statements.filter((s) => [s.Action].flat().some((a) => a.startsWith("ssm:")));
    expect(ssm).toHaveLength(1);
    expect(ssm[0]?.Action).toBe("ssm:GetParameters");
    const arns = JSON.stringify(ssm[0]?.Resource);
    expect(arns).toContain(":ssm:ap-southeast-2:");
    expect(arns).toContain(":parameter/invoice-chaser/openrouter-key");
    expect(arns).toContain(":parameter/invoice-chaser/api-token");
    expect((ssm[0]?.Resource as unknown[]).length).toBe(2);
    expect(arns).not.toContain("*");
    for (const s of statements) {
      const actions = [s.Action].flat();
      expect(actions.some((a) => /^(secretsmanager|kms):/.test(a) || a === "*")).toBe(false);
      expect(JSON.stringify(s.Resource)).not.toBe('"*"');
    }
  });

  it("tags everything it can with the project", () => {
    for (const type of [
      "AWS::DynamoDB::Table",
      "AWS::Lambda::Function",
      "AWS::Logs::LogGroup",
      "AWS::IAM::Role",
    ]) {
      template.hasResourceProperties(type, {
        Tags: Match.arrayWith([{ Key: "project", Value: "invoice-chaser" }]),
      });
    }
  });
});

import { App } from "aws-cdk-lib";
import { InvoiceChaserStack } from "../lib/stack.js";

/**
 * Region-specific, account-agnostic: synthesises with no AWS credentials. The account is
 * filled in at deploy time from whichever profile deploys it (set up by AWS_PLAN.md's manual steps).
 */
const app = new App();
new InvoiceChaserStack(app, "InvoiceChaser", {
  env: { region: "ap-southeast-2" },
  description:
    "Invoice chaser demo: one Lambda with a function URL, one DynamoDB table (5/5 provisioned).",
});

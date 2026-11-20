# AWS plan

Status: **a plan, nothing built.** No account exists yet, no CDK code is written and the AWS CLI isn't installed. This file says what the AWS stage will look like, what it should cost, and which steps only Rod can do.

## The shape

One small stack in **Sydney (`ap-southeast-2`)**, written in **CDK (TypeScript)** in an `infra/` folder of this repo.

| piece                   | what it does                                                                                               | sizing and guardrails                                                                                                                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AWS Budgets alert**   | emails Rod when spend crosses a line                                                                       | created by hand **before anything else**: $5 a month, alerts at 50%, 80% and 100% of actual and 100% of forecast                                                                                                                 |
| **Lambda function**     | runs the same `Chaser` and HTTP routes as `npm run serve`, behind a small handler                          | Node.js 24 runtime if it's offered in Sydney when we build (fall back to 22 otherwise), arm64, 512 MB, 30 second timeout, **reserved concurrency of 2** so a flood of requests can't run up a bill                               |
| **Function URL**        | the HTTPS endpoint                                                                                         | auth type `NONE`, with the existing bearer-token check in the code. Simpler than signing requests, but it means the token is the only lock, so it stays long, random and in Parameter Store                                      |
| **DynamoDB table**      | delivery records, the audit log, model spend, the approval checkpoints, and the stand-in outbox's messages | one table, `pk`/`sk` (design in `src/storage/dynamodb.ts`), **provisioned capacity, 5 read and 5 write units** (under the 25 and 25 in the always-free tier), no autoscaling, point-in-time recovery off, removal policy destroy |
| **SSM Parameter Store** | the OpenRouter key and the API token                                                                       | two `SecureString` parameters in the standard tier, encrypted with the AWS-managed `aws/ssm` key. **Put there by Rod**, never in code, CDK context or environment variables. The function's role can read only those two         |
| **CloudWatch Logs**     | the function's logs                                                                                        | log group created by the stack with **7-day retention** and removal policy destroy, so logs don't pile up                                                                                                                        |

Tags on everything: `project=invoice-chaser`.

## What has to change in the code first

1. **Persist the approval checkpoint.** Locally, a run waiting for approval lives in LangGraph's in-memory saver. A Lambda can be a different container on the next request, so the checkpointer has to be stored, in the same DynamoDB table. Either an existing LangGraph DynamoDB checkpointer if a maintained one fits, or a small `BaseCheckpointSaver` of our own with tests.
2. **Build `DynamoDbStore`** to the design already in `src/storage/dynamodb.ts`, and run the same storage tests against it (DynamoDB Local in a container, so CI needs no AWS account).
3. **Keep the stand-ins.** There's still no real Xero or ServiceM8. The stand-ins run in-process with the seed data, and the outbox stores its messages in DynamoDB so a readback still works after a cold start. It's a demo deployment and the README will say so.
4. **Lambda handler** that maps the function URL event to the existing routes, and reads the two parameters once per cold start.

## Cost

Expected: about $0 a month for the AWS side at demo traffic, plus model spend through OpenRouter, which is capped in code (default $0.05 a run, $0.50 for the project).

That rests on the always-free allowances: Lambda (1 million requests and 400,000 GB-seconds a month), DynamoDB (25 read and 25 write units of provisioned capacity, 25 GB), standard Parameter Store parameters, and the CloudWatch Logs free allowance. CDK's bootstrap also creates a small S3 bucket for deployment files, which costs cents at most.

**Check this when the account is created.** AWS changed its free tier for new accounts in mid-2025 (a credit-based free plan for new accounts, alongside the always-free services). I haven't checked the current terms against AWS's own pages for this plan, and the budget alert exists because estimates like this one can be wrong.

## Steps only Rod can do

These need his identity, card or a browser session, so they're his. Nothing in this repo does them.

1. **Create the AWS account** at aws.amazon.com with an email address he controls. Pick the plan (free or paid) knowingly.
2. **Turn on MFA for the root user** straight away. Don't create access keys for root. After this, root is only for billing and account settings.
3. **Create the budget alert** (Billing and Cost Management, Budgets): monthly cost budget, $5, email alerts at 50%, 80% and 100% actual and 100% forecast. Turn on free-tier usage alerts too.
4. **Set up IAM Identity Center** in `ap-southeast-2`, create a user for himself with MFA, and give it a permission set on the account. For a personal sandbox account, `AdministratorAccess` is the practical choice, because CDK's bootstrap creates IAM roles.
5. **Install the AWS CLI v2.** It installs to a user folder without sudo (`./aws/install -i ~/.local/aws-cli -b ~/.local/bin`).
6. **Sign the CLI in with SSO.** Run this in a terminal:

   ```bash
   aws configure sso            # profile name: invoice-chaser, region: ap-southeast-2
   aws sso login --profile invoice-chaser
   aws sts get-caller-identity --profile invoice-chaser
   ```

7. **Put the two secrets in Parameter Store** himself, typed at a hidden prompt so they don't land in shell history. Run this in a terminal:

   ```bash
   read -rs OPENROUTER_KEY && aws ssm put-parameter --profile invoice-chaser --region ap-southeast-2 --name /invoice-chaser/openrouter-key --type SecureString --value "$OPENROUTER_KEY" && unset OPENROUTER_KEY
   ```

   And the same for `/invoice-chaser/api-token` with a fresh random value.

## Then the build (a later session, with Rod's go-ahead at each gate)

1. Code changes above, with tests, all still runnable with no AWS account.
2. `infra/` CDK app. `cdk synth` and `cdk diff` output goes to Rod before anything is created.
3. `cdk bootstrap aws://<account>/ap-southeast-2` once, then `cdk deploy`, both run by Rod or with his explicit OK.
4. Smoke test: health check, one run, approve, check the stand-in outbox holds one message and the audit log is in DynamoDB.
5. Check the bill the next day, before leaving it running.

## Taking it all down

```bash
npx cdk destroy --profile invoice-chaser
```

The table and the log group have removal policy destroy, so they go with the stack. Two things `cdk destroy` leaves behind: the CDK bootstrap stack (`CDKToolkit`, with its S3 bucket, which has to be emptied before the stack can be deleted in CloudFormation) and the two Parameter Store values (`aws ssm delete-parameter`). The budget alert stays until Rod deletes it, which is fine.

# AWS plan

Status, 22 Nov 2026: **built and tested locally, not deployed.** The code changes and the CDK stack below exist and are tested offline, with DynamoDB Local in Docker standing in for DynamoDB. There's still no AWS account, no credentials, no `cdk bootstrap` and no `cdk deploy`. Nothing here has run on AWS, so nothing here is shown to work on AWS.

## The shape

One small stack in **Sydney (`ap-southeast-2`)**, in CDK (TypeScript) at `infra/lib/stack.ts`.

| piece                   | what it does                                                                                                       | sizing and guardrails                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AWS Budgets alert**   | emails me when spend crosses a line                                                                                | created by hand **before anything else**: $5 a month, alerts at 50%, 80% and 100% of actual and 100% of forecast. Not in the stack                                                      |
| **Lambda function**     | runs the same `Chaser` and routes as `npm run serve`, through `src/lambda/handler.ts`                              | `nodejs24.x`, arm64, 512 MB, 30 second timeout, **reserved concurrency of 2**                                                                                                           |
| **Function URL**        | the HTTPS endpoint                                                                                                 | auth type `NONE`, with the bearer-token check in the code. The token is the only lock, so it's long, random and in Parameter Store                                                      |
| **DynamoDB table**      | delivery records, run claims, the audit log, model spend, approval checkpoints, and the stand-in outbox's messages | one table, `pk`/`sk`, **provisioned 5 read and 5 write units** (under the always-free 25 and 25), no autoscaling, no indexes, point-in-time recovery off, removal policy destroy        |
| **SSM Parameter Store** | the OpenRouter key and the API token                                                                               | two `SecureString` parameters, **put there by hand**. The stack only references their names. The function's role may call `ssm:GetParameters` on those two ARNs and nothing else in SSM |
| **CloudWatch Logs**     | the function's logs                                                                                                | a log group with **7-day retention** and removal policy destroy                                                                                                                         |

Tags on everything: `project=invoice-chaser`.

## What's built and tested locally

All of it runs with no AWS account. Test counts are from `npm test` with DynamoDB Local running (120 tests) and without it (104 pass, 16 DynamoDB tests skip with a label saying why).

1. **`DynamoDbStore`** (`src/storage/dynamodb.ts`) to the single-table design. Send-once rests on conditional writes: a delivery is inserted only if its key doesn't exist, and a run can be claimed for resuming only once. One contract test file runs against both SQLite and DynamoDB Local, including five concurrent inserts and claims (exactly one wins), a lost reply plus a retry (one message), and two processes sending the same reminder at once (one message, the other process stands back).
2. **A persisted checkpointer** (`src/storage/checkpoint.ts`). There's no maintained DynamoDB checkpointer for LangGraph.js (the one npm package is a single release from one person), so this is a small `BaseCheckpointSaver` of our own, modelled on LangGraph's `MemorySaver`, over a sorted key-value interface with DynamoDB and SQLite backends. LangChain's official checkpoint validation suite pins an older Vitest, so its contract is mirrored in our own tests instead. **Approve after a restart is proven**: one process starts a run, a fresh one with nothing in memory shows the same drafts, approves and sends, and a third can't resume it again. That's tested on SQLite, on DynamoDB Local, and end to end through the Lambda handler on both.
3. **The stand-ins stay.** There's still no real Xero or ServiceM8. On Lambda they start in-process with the seed data. The outbox keeps its messages in the table, and a test shows a fresh outbox instance (a new container) finding a message by readback.
4. **Lambda handler** (`src/lambda/handler.ts`). It maps a function URL event onto the same router the local server uses, so the two can't drift. The two parameters are read through a `SecretSource` interface, once per cold start. A failed cold start answers 503 and is tried again on the next request. Tests use a saved sample event (payload format 2.0, base64 body) and a fake secret source; the real `SsmSecretSource` is only tested against a fake SSM client. Each request logs method, path, status and milliseconds, never headers or bodies.
5. **The CDK stack** (`infra/`). `test/infra.test.ts` pins every guardrail in the table above with `aws-cdk-lib/assertions`, writing the expected values out rather than importing them. `npm run infra:drift` changes the stack nine ways (memory, architecture, reserved concurrency, on-demand billing, autoscaling, log retention, retain-on-destroy, an SSM wildcard, IAM auth on the URL) and requires the tests to fail each time. They do.
6. **`cdk synth` with no credentials.** The stack is region-specific and account-agnostic. On this laptop (no `~/.aws`, no `AWS_` variables) it synthesises in about 6 seconds: 8 resources (the table, the log group, a role and its policy, the function, the URL and two invoke permissions), no custom resources, and an ESM bundle of 3.7 MB built locally by esbuild with the AWS SDK included. The bundle imports cleanly in Node 24 without calling anything.
7. **CI** (`.github/workflows/ci.yml`) adds the drift check and `cdk synth` to the main job, and a second job runs every test against a DynamoDB Local service container (image pinned by digest) with `REQUIRE_DYNAMODB=1`, so a missing database fails there instead of skipping. Both jobs passed on the first push.

**Skipped: AWS SAM CLI.** It would install without sudo (Python venv in a user folder), but `sam local invoke` runs the function in a container of its own architecture. The function is arm64 and this laptop is x86_64 with no arm64 emulation registered, and registering emulation needs a privileged container, which is root access in practice. The handler test with a sample function URL event covers the event mapping instead. It doesn't cover the Lambda runtime itself.

## What still needs a real account

Nothing below has been tried, and none of it can be shown locally.

- **The deploy itself:** `cdk bootstrap`, `cdk deploy`, and CloudFormation accepting the template.
- **IAM really working:** that the role can read the two parameters (including decrypting with the AWS-managed `aws/ssm` key, which normally needs no extra KMS permission) and the table, and is refused everything else.
- **Real Parameter Store:** `SsmSecretSource` has only met a fake client.
- **Reserved concurrency.** New accounts often start with a low total concurrency quota, and AWS refuses reserved concurrency that would leave less than its minimum unreserved. If the deploy fails on this, the choice is to ask for a quota increase or drop the reservation and rely on the budget alert. I'll decide that when it happens.
- **Real cold starts:** start-up time with a 3.7 MB bundle, three in-process stand-ins and the SDK, against the 30 second timeout. Unmeasured.
- **The function URL from the internet:** auth `NONE` plus the two invoke permissions CDK adds, behaving as expected.
- **DynamoDB at 5 and 5 units:** throttling under load, and the 400 KB item limit on one checkpoint (fine for the seed data, not checked for large runs).
- **The bill.** The cost estimate below is an estimate.

## Cost

Expected: about $0 a month for the AWS side at demo traffic, plus model spend through OpenRouter, which is capped in code (default $0.05 a run, $0.50 for the project). The deployed function uses the scripted model (`INVOICE_CHASER_LIVE=0`) until I decide otherwise.

That rests on the always-free allowances: Lambda (1 million requests and 400,000 GB-seconds a month), DynamoDB (25 read and 25 write units of provisioned capacity, 25 GB), standard Parameter Store parameters, and the CloudWatch Logs free allowance. CDK's bootstrap also creates a small S3 bucket for deployment files, which costs cents at most.

**Check this when the account is created.** AWS changed its free tier for new accounts in mid-2025 (a credit-based free plan for new accounts, alongside the always-free services). I haven't checked the current terms against AWS's own pages, and the budget alert exists because estimates like this one can be wrong.

## Manual steps, outside the code

These need the account owner's identity, card or a browser session, so they're done by hand. Nothing in this repo does them.

1. **Create the AWS account** at aws.amazon.com with an email address you control. Pick the plan (free or paid) knowingly.
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

   And the same for `/invoice-chaser/api-token` with a fresh random value of 16 characters or more.

## Then the deploy (a deliberate go-ahead at each gate)

1. ~~Code changes, with tests, runnable with no AWS account.~~ Done.
2. ~~`infra/` CDK app and `cdk synth`.~~ Done. Still to do with the account: `cdk diff`, read in full before anything is created.
3. `cdk bootstrap aws://<account>/ap-southeast-2` once, then `cdk deploy`, both run by hand, never from CI.
4. Smoke test: health check, one run, approve, check the outbox messages and the audit log are in the table.
5. Check the bill the next day, before leaving it running.

## Taking it all down

Run this in a terminal:

```bash
cd infra && npx cdk destroy --profile invoice-chaser
```

The table and the log group have removal policy destroy, so they go with the stack (a test checks both). Two things `cdk destroy` leaves behind: the CDK bootstrap stack (`CDKToolkit`, with its S3 bucket, which has to be emptied before the stack can be deleted in CloudFormation) and the two Parameter Store values (`aws ssm delete-parameter`). The budget alert stays until it's deleted by hand, which is fine.

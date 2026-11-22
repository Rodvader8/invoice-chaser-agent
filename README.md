# Invoice Chaser

An agent service in TypeScript that helps an Australian trade business chase unpaid invoices. It reads overdue invoices from an accounting system and job details from a job system, works out who to chase and for how much, has a model draft one reminder per customer, checks the draft, waits for a person to approve it, and sends it in a way that can't double-send when a reply goes missing.

The model writes the words. The code decides everything else: the amounts owed, days overdue, any late fee, who gets held for a person, and whether a draft is safe to show anyone.

Everything here runs locally against stand-in servers with invented data. There's no real Xero, no real ServiceM8, no real mail or SMS provider, and nothing deployed to AWS. The AWS version (Lambda, DynamoDB, CDK) is built and tested offline only; see [AWS on paper and offline](#aws-on-paper-and-offline). Every test and the evaluation use a scripted fake model, so none of them need an API key or spend any money. See [Limits](#limits).

## How it works, in order

1. **Read.** HTTP clients call two stand-ins written for this repo: a Xero-like accounting API (contacts, invoices, payments) and a ServiceM8-like job API (jobs, badges, notes). Responses are validated with zod. Dollar amounts arrive as decimals, as Xero sends them, and are converted to whole cents straight away; a value with more than two decimals is refused (`src/money.ts`, `src/clients/`).
2. **Decide, in code.** `src/assess.ts` is a pure function that turns those records into one decision per customer: chase (with the figures), skip, or hold for a person. The rules are written out in [`evals/PREREGISTRATION.md`](evals/PREREGISTRATION.md). In short: owed is the total minus payments, all in cents; a disputed job, a missing job, figures that disagree with the accounting system's own amount due, or no way to contact the customer all hold the whole customer; a $25 late fee applies only to customers who accepted the terms and only from 30 days overdue; the stage (friendly, firm, final) comes from the most overdue invoice.
3. **Draft.** The model gets a fact sheet with every figure already computed and formatted (`"$1,320.00"`, never raw numbers to add up), and the invoice and job notes in a separate block marked as untrusted. Notes can't close that block early. It answers with JSON (`{subject, body}`), validated with zod (`src/draft/`).
4. **Check, in code, before a person sees it.** A draft fails if a dollar figure isn't one of the computed ones, the total is missing, a chased invoice is missing or an unchased one appears, it mentions a fee when none applies, it carries a BSB, account number, phone number, email address or link that isn't the business's own, or it's too long (SMS 480 characters). A failing draft gets one retry with the reasons fed back; if that fails too, the customer is held (`src/draft/check.ts`).
5. **Approve.** The LangGraph.js workflow (`src/graph.ts`: assess, draft, approve, send) stops at an `interrupt()` and waits. Each approval carries the SHA-256 of the exact draft that was shown, so an approval for different content isn't an approval. A draft with no decision isn't sent. A run waiting for approval is saved by a checkpointer (`src/storage/checkpoint.ts`, SQLite locally, DynamoDB on AWS), so a different process can pick it up and approve it, and a stored conditional claim stops two people resuming the same run.
6. **Re-read.** Just before sending, the code reads each invoice again. If the customer has paid in the meantime, or anything owed has changed, it doesn't send (`stale`).
7. **Send.** One idempotency key per reminder (customer, date, stage, channel, invoices and amounts), with Tender Desk's lost-reply protocol (`src/send/sender.ts`):

| what happened                        | what the sender does                       | state                                     |
| ------------------------------------ | ------------------------------------------ | ----------------------------------------- |
| answer received and it matches       | record the outbox's reference              | `sent`                                    |
| timeout, dropped connection or 5xx   | read back by key before anything else      | decided by the readback                   |
| ...readback shows our message        | send nothing more                          | `sent`                                    |
| ...readback shows nothing            | resend with the same key, up to 3 attempts | `sent` or `failed`                        |
| ...readback shows different content  | stop                                       | `conflict`                                |
| ...readback fails too                | don't resend, don't call it sent           | `unknown`, settled later by `reconcile()` |
| clear refusal (4xx)                  | no retry                                   | `failed`                                  |
| key already `sent` on an earlier run | nothing                                    | `already_sent`                            |

The attempt is written to storage before the request goes out, so a crash leaves a trace. The stand-in outbox, by default, stores the key but doesn't refuse a repeat (like many SMS gateways), so the readback is the only thing standing between a lost reply and a second message.

8. **Record.** A `Store` interface holds delivery records, run claims, the audit log and model spend. `SqliteStore` uses Node's built-in `node:sqlite`; `DynamoDbStore` uses one DynamoDB table. Both pass the same contract tests. The audit log keeps ids, states, reasons and hashes, never message bodies, notes or keys (a test checks).

The same `Chaser` class sits behind the HTTP API, the Lambda handler, the terminal demo and the evaluation, and the HTTP API and the Lambda handler share one router, so they all run the same path.

## Run it locally

Needs Node 24. No key, no account.

```bash
npm ci
npm test                 # 120 tests; the 16 DynamoDB ones skip (labelled) without Docker
npm run eval             # offline evaluation, 35 frozen cases
npm run eval:break       # breaks the code 4 ways and checks the evaluation notices
npm run lint && npm run typecheck && npm run build
```

With Docker, the DynamoDB tests run too:

```bash
npm run dynamodb:start   # amazon/dynamodb-local, pinned by digest, on 127.0.0.1:8000
npm run test:dynamodb    # all 120; fails instead of skipping if DynamoDB Local isn't there
npm run dynamodb:stop
```

Try it:

```bash
npm run demo                       # one run on the invented seed data; asks you about each draft
npm run demo -- --approve-all      # same, approving everything
```

The HTTP API, on 127.0.0.1:

```bash
export INVOICE_CHASER_API_TOKEN=$(openssl rand -hex 24)
npm run serve
```

| route                                                                                 | does                                                                              |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `GET /health`                                                                         | no token needed                                                                   |
| `POST /runs` `{asOf?}`                                                                | starts a run; returns the drafts waiting for approval and who was skipped or held |
| `GET /runs/:id`                                                                       | where a run stands                                                                |
| `POST /runs/:id/decisions` `{reviewer, decisions: [{contactId, approve, draftHash}]}` | resumes the run and sends what was approved                                       |

Everything except `/health` needs `Authorization: Bearer <token>`, compared in constant time. There are no user accounts, so the reviewer name is typed in, not authenticated.

| setting                                    | meaning                                                                                               |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `INVOICE_CHASER_API_TOKEN`                 | bearer token for the API, 16+ characters; the server won't start without it                           |
| `INVOICE_CHASER_PORT`, `INVOICE_CHASER_DB` | default 8787 and `invoice-chaser.db`                                                                  |
| `ACCOUNTING_URL`, `JOBS_URL`, `OUTBOX_URL` | point at running stand-ins (`npm run standins`); if unset, they start in-process with `src/seed.json` |
| `INVOICE_CHASER_LIVE=1` / `--live`         | use a real model through OpenRouter instead of the scripted one (see below)                           |

## MCP server

`npm run mcp` starts a Model Context Protocol server over stdio (official TypeScript SDK) so an AI client can look things up. It's read only.

| tool                      | returns                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| `list_customers_to_chase` | each customer's decision, with the figures from the same `assess()` the agent uses          |
| `get_invoice`             | one open invoice: total, paid, owed, days overdue, and its notes labelled `untrusted_notes` |
| `get_job`                 | one job: description, status, badges, notes labelled `untrusted_notes`                      |

It can't draft, approve or send, and it doesn't return customer email addresses or phone numbers. Inputs are typed and pattern-checked. Each call logs one line to stderr with the tool, milliseconds and outcome, never the arguments or results. Tests cover the tool list, the read-only annotations, the figures, input validation and the log lines.

## Model and spend

`ScriptedModel` (`src/model/scripted.ts`) reads the facts out of the prompt and writes a template reminder. For the evaluation it can also misbehave on purpose: copy injected notes into the draft, state a wrong total, invent a fee, drop an invoice, return broken JSON once.

`OpenRouterModel` is the live client. It asks for structured JSON output and runs behind `SpendGuard`, which checks a worst-case estimate before every call against a per-run cap, a project cap (stored, so it holds across runs) and an account-balance floor. A call that fails after it was sent is charged at the estimate. The tests drive it with a fake `fetch`. **It hasn't been run against the real API yet.** A live run needs `OPENROUTER_API_KEY`, `INVOICE_CHASER_MODEL` and the model's prices (`INVOICE_CHASER_PRICE_IN_PER_MTOK`, `_OUT_PER_MTOK`); caps default to $0.05 per run, $0.50 for the project and a $1 balance floor.

## What was measured

Pre-registered first: the questions, the rules, the 35 cases and the pass criteria were committed together (the first commit, `fbd0c46`) before any system code existed. The set's SHA-256 is in `evals/CHECKSUMS.sha256` and the runner refuses to score a changed set (a test edits one figure in a copy and checks it's refused).

Result of `npm run eval` (saved in `evals/results/offline.json`):

| metric                                                                           | result  | criterion |
| -------------------------------------------------------------------------------- | ------- | --------- |
| M1 money exact (owed, days, fee per invoice; total, stage, channel per customer) | 43 / 43 | 100%      |
| M2 action and reason per customer                                                | 36 / 36 | 100%      |
| M3a bad drafts held before approval                                              | 6 / 6   | 100%      |
| M3b good drafts allowed through                                                  | 21 / 21 | 100%      |
| M4a messages at the outbox equal the expected count                              | 36 / 36 | 100%      |
| M4b final delivery state                                                         | 22 / 22 | 100%      |
| M5 nothing sent without approval                                                 | 1 / 1   | 100%      |
| duplicate messages                                                               | 0       | 0         |

All 35 cases pass. The traps include prompt injection in an invoice note (swap the bank account, say the balance is $0, send remittance to another address), a disputed invoice, a partial payment, a customer who already paid, payments that sum exactly in decimal but not in floating point, a payment that lands between approval and sending, and lost replies (dropped, 503, a real socket timeout, a failed readback).

**The evaluation can fail.** `npm run eval:break` copies the repo, makes one change at a time and requires the evaluation to fail in named cases (output in `evals/results/break-check.txt`):

| break                                           | caught by                                                      |
| ----------------------------------------------- | -------------------------------------------------------------- |
| skip the readback after a lost reply            | 4 sending cases (each sent twice, or called sent when unknown) |
| ignore payments when computing owed             | partial payment, float trap, paid in full, figures disagree    |
| switch off the payment-details check            | injected bank details, injected email address                  |
| late fee from more than 30 days, not 30 or more | the 30-day boundary case                                       |

The break check also refuses a break that no longer matches the code. That mattered once already: after the code was reformatted, the readback break silently stopped applying, the check reported it as out of date instead of passing, and the break was fixed (the two commits before that fix carry the stale version).

For the unit tests, the readback, the payment-details call and the approval binding were each mutated by hand, one at a time: 7, 2 and 1 tests went red respectively, and all 77 tests the repo had then passed again once the code was restored.

**How much this shows.** The model is scripted, so these numbers measure the code around a model, not a model. They say the rules are applied exactly, bad drafts of the kinds tested are stopped, and sending survives the faults tested. They don't say how well a real model writes a reminder, how often it would trip the checks, or how customers would respond. The same author wrote the rules, the cases and the code, so a mistake nobody thought of won't be in the set.

## Limits

- **Stand-ins only.** The accounting, job and outbox servers are mine, in memory, with simplified Xero-like and ServiceM8-like shapes (for example, late-fee acceptance is a contact field and job notes are inlined). Real APIs need OAuth, paging, rate limits and their own idempotency behaviour, none of which is shown.
- **Invented data.** Every business, person, invoice and job is made up.
- **Scripted model only.** No live model run yet. The draft checks were tested against the ways the scripted model misbehaves, not against a real model's mistakes.
- **The checks are pattern rules.** A draft that writes "eight hundred dollars" or an account number with unusual spacing could get past the figure or payment-details checks. A false hold is safe (a person looks); a miss isn't, which is why a person approves every draft anyway.
- **The checkpointer is ours.** No maintained DynamoDB checkpointer for LangGraph.js exists, so `KvCheckpointSaver` is written here and tested against our own copy of the contract, not LangChain's official validation suite (which pins an older Vitest). `list()` needs a thread id, and one run's state has to fit in a 400 KB DynamoDB item. The terminal demo still uses the in-memory saver.
- **One shared API token**, no user accounts, reviewer typed in. Don't expose it to the internet as it stands.
- **No editing.** The person approves or rejects a draft; they can't edit it here.
- **`reconcile()` is a function,** not a scheduled job or an API route.
- **Not deployed.** The Lambda, DynamoDB and CDK code is tested offline only. Nothing has run on AWS.
- **CI hasn't run.** `.github/workflows/ci.yml` (lint, types, tests, evaluation, break check, build, audit; actions pinned by commit, read-only permissions) runs only once the repo is pushed to GitHub.

## Stack

Node 24, TypeScript 6.0 in strict mode (7.0 is out, but typescript-eslint doesn't support it yet), LangGraph.js, zod 4, the official MCP TypeScript SDK, Vitest, ESLint (typescript-eslint strict type-checked) and Prettier. AWS side: the AWS SDK v3 (DynamoDB, SSM) and CDK v2 (a dev dependency). Runtime dependencies: eight.

## AWS on paper and offline

The AWS stage is built and tested locally, with no AWS account. [AWS_PLAN.md](AWS_PLAN.md) has the detail, including what still needs a real account.

- **`infra/`**: one CDK stack in Sydney. One Lambda function (`nodejs24.x`, arm64, 512 MB, 30 seconds, reserved concurrency 2) behind a function URL, one DynamoDB table at a fixed 5 read and 5 write units, a log group kept 7 days, read access to exactly two Parameter Store names, everything deleted by `cdk destroy`. `test/infra.test.ts` pins each of those. `npm run infra:drift` changes the stack nine ways and checks the tests fail every time.
- **`npm run cdk:synth`** works with no credentials (the stack is account-agnostic) and bundles the handler with esbuild. No `cdk bootstrap` or `cdk deploy` has ever run.
- **`src/lambda/`**: the handler maps function URL events onto the shared router and loads the two secrets once per cold start through an interface. Tests use a saved sample event and a fake secret source; no call to real SSM is made anywhere.
- **DynamoDB Local** (Docker) runs the store, checkpointer and handler tests against a real DynamoDB API. It caught one bug SQLite couldn't: DynamoDB refuses `begins_with(sk, "")`.

## Licence

MIT.

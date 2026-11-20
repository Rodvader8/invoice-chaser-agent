# Pre-registration: offline evaluation of the invoice chaser

Written 20 Nov 2026, before any of the system's code existed. This file, `evals/cases.json` and its checksum were committed together in the first commit, so the git history shows what was decided before a single run.

## What this evaluation can and can't answer

Every run uses a **scripted fake model**, not a real one. The fake is told, per case, to behave well or to misbehave in a specific way (state a wrong figure, invent a fee, copy an injected instruction into the draft). So this evaluation measures the **code around the model**: the money it computes, the decisions it makes about who to chase, the checks it runs on a draft before a person sees it, and how it sends. It says nothing about how well a real model writes a reminder. That needs a live run, and Rod hasn't approved spend.

The same author wrote the rules, the cases and the code. That's a real weakness: a case can only catch a mistake the author thought of. The deliberate-break check (below) is the partial answer. It changes the code in ways that should break it and confirms the evaluation notices.

## Business rules under test

These are the rules the code must implement. They're fixed here so a case can't be quietly changed to match whatever the code happened to do.

1. **Money is integer cents.** The accounting API returns dollars as decimal numbers (like Xero). The code converts each one to whole cents, refuses any value with more than two decimal places, and does all arithmetic in cents.
2. **Owed** on an invoice = total minus the sum of its payments. If owed is zero or less, the invoice isn't chased.
3. Only invoices with status `AUTHORISED` are considered. `PAID`, `VOIDED` and `DRAFT` are ignored.
4. **Cross-check:** if the accounting API's own `AmountDue` disagrees with the computed owed, the whole customer is held (`figures_disagree`). A person looks.
5. **Days overdue** = whole calendar days from the due date to the run date (both as dates in Sydney time). Zero or less means not overdue, not chased.
6. **Disputes:** each invoice links to a job (`Reference: "Job #1042"`). If any of a customer's chaseable invoices has a job with the `DISPUTED` badge, the whole customer is held (`dispute_open`). If the job can't be found, the customer is held (`job_not_found`), because the code can't rule out a dispute.
7. **Late fee:** $25.00 (2,500 cents) per invoice, once, only if the customer accepted the late-fee terms **and** the invoice is 30 or more days overdue.
8. **Stage** from the most overdue chased invoice: 1 to 13 days `friendly`, 14 to 29 `firm`, 30 or more `final`.
9. **Channel:** email if the contact has an email address, otherwise SMS if they have a mobile, otherwise hold (`no_contact_channel`). The recipient always comes from the accounting contact, never from the model.
10. **One reminder per customer**, covering all their chased invoices. Total requested = sum of owed plus sum of fees.
11. **Draft checks, in code, before a person sees the draft.** A draft fails if: any dollar figure in it isn't one of the computed figures (each invoice's owed, each fee, the total requested); the total requested is missing; a chased invoice number is missing; an invoice number that isn't being chased appears; it contains a BSB, an account number, an email address, a phone number or a URL that isn't the business's own; it mentions a fee when none applies; or it's over the length limit (SMS 480 characters, email body 2,000). A failing draft gets one retry with the reasons fed back. If the retry fails too, the customer is held (`draft_failed_checks`).
12. **Nothing is sent without a person's approval.** A rejected draft is never sent.
13. **Before sending,** the code reads the invoices again. If any chased invoice's owed amount has changed, it doesn't send (`stale`).
14. **Idempotency key** per reminder, built from the customer, run date, stage, channel and each invoice number with its owed cents. If a delivery with that key is already `sent`, nothing new goes out (`already_sent`).
15. **Sending is lost-reply safe**, the same protocol as Tender Desk's quote sender:

| what happened                       | what the sender does                              | state                   |
| ----------------------------------- | ------------------------------------------------- | ----------------------- |
| answer received and it matches      | record the outbox's reference                     | `sent`                  |
| timeout, dropped connection or 5xx  | read back by key before anything else             | decided by the readback |
| ...readback shows our message       | send nothing more                                 | `sent`                  |
| ...readback shows nothing           | resend with the same key, up to 3 attempts in all | `sent` or `failed`      |
| ...readback shows different content | stop                                              | `conflict`              |
| ...readback fails too               | don't resend, don't call it sent                  | `unknown`               |
| clear refusal (4xx)                 | no retry                                          | `failed`                |

## Questions

- **Q1. Does the code compute what's owed correctly?** Owed cents, days overdue, fee cents per invoice, and total requested and stage per customer.
- **Q2. Does it decide correctly who to chase and who to hold?** Action and reason per customer.
- **Q3. Do the draft checks stop a bad draft before a person sees it, without blocking good ones?**
- **Q4. Is sending safe?** Exactly the expected number of messages reach the outbox, and the final delivery state is the expected one, including when replies are lost.
- **Q5. Does nothing go out without approval?**

## Frozen test set

`evals/cases.json`, 35 invented cases (some have two customers). SHA-256 recorded in `evals/CHECKSUMS.sha256`. The runner refuses to score if the file doesn't match. Every name, address, invoice and job is made up.

| group              | cases                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| money              | single invoice, two invoices for one customer, partial payment, float trap (payments that sum exactly to the total in decimal), 30-day fee boundary, 29-day boundary, fee without accepted terms, stage boundaries at 13 and 14 days                                                                                                                                    |
| who to chase       | already paid but status not updated, status `PAID`, not yet due, due today, disputed, one of two invoices disputed, job not found, figures disagree, no contact channel, SMS-only contact                                                                                                                                                                               |
| traps in the draft | injection asking to pay a different account (model follows it), injection asking to say the balance is $0 (model follows it), injection asking the model to send remittance to someone else's email (model follows it), injection with a faithful model, model states a wrong total, model invents a fee, model drops an invoice number, model returns broken JSON once |
| sending            | reply lost after the outbox applied it, 503 after it applied it, dropped before it arrived, real timeout over a socket, readback fails too, outbox refuses with 400, paid between approval and send, rejected by the person, a second run on the same day                                                                                                               |

## Pass criteria

The fake model is deterministic, so each case runs once and there's no sampling noise. **Every metric must be 100%. One miss fails the evaluation.** The thresholds aren't a judgment about acceptable error. With a scripted model, any miss is a bug in the code.

| metric                   | measured over                                                                                      | pass                            |
| ------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------- |
| M1 money exact           | every expected chased invoice (owed, days, fee) and every chased customer (total, stage)           | 100% exact                      |
| M2 action and reason     | every customer in every case                                                                       | 100%                            |
| M3a bad drafts blocked   | cases where the fake misbehaves on every attempt: draft held, never reaches approval, nothing sent | 100%                            |
| M3b good drafts allowed  | cases with a faithful fake (or one that recovers on retry): draft passes                           | 100%                            |
| M4a outbox message count | every customer: messages at the outbox equal the expected count (0 or 1)                           | 100%, and 0 duplicates in total |
| M4b delivery state       | every customer that reaches sending: final state equals expected                                   | 100%                            |
| M5 approval              | rejected cases: 0 messages                                                                         | 100%                            |

## The deliberate-break check

`npm run eval:break` copies the repo to a temporary folder, makes one change at a time, and runs the evaluation on the broken copy. It passes only if every break makes the evaluation fail in the named cases:

1. Skip the readback (treat every lost reply as "not received") → the lost-reply cases send twice.
2. Ignore payments when computing owed → the partial-payment and paid cases fail.
3. Switch off the payment-details check → the injected-account case sends a draft with someone else's bank details.
4. Change the fee rule from 30 or more days to more than 30 → the boundary case fails.

If a break doesn't make the evaluation fail, the check itself fails. That's how the evaluation proves it can fail.

## What would change these rules

Nothing after the first run. If a case turns out to be wrong, it stays in the history: the fix gets its own commit, with the reason, and the results before and after are both kept.

# QuickLend - Production Ledger API

A small lending engine. It handles term loans and invoice quotes on top of a double-entry ledger, and it is built to stay correct when payments arrive twice, in parallel, out of order, or get reversed.

Currency is NGN. All amounts are integer **kobo** (₦1 = 100 kobo). There are no floats anywhere in the money path.

Assumptions, what I verified by hand, and what I didn't get to are in [NOTES.md](./NOTES.md).

## Stack

- Node 22, Express 5, TypeScript
- Prisma 7 (with raw SQL for triggers, locks and reporting queries)
- Postgres 17
- Zod for request validation
- BullMQ + Redis, only for an optional nightly accrual schedule
- Vitest + Supertest

## Running it

### Everything in Docker

```bash
docker compose up --build
```

This starts the API on http://localhost:4010 with Postgres and Redis. The app container applies migrations on startup.

### Local development

```bash
cp .env.example .env        # or create .env
docker compose up -d db redis
npm install
npx prisma migrate deploy   # applies the schema and the DB triggers
npm run dev
```

### Environment

`.env` (host-side, used by `npm run dev` and Prisma):

```
DATABASE_URL=postgresql://ledger:ledger@localhost:54329/ledger
REDIS_URL=redis://localhost:63790
PORT=4010
```

`.env.test`:

```
DATABASE_URL=postgresql://ledger:ledger@localhost:54330/ledger_test
```

Host ports are deliberately non-default (Postgres 54329, test Postgres 54330, Redis 63790, app 4010) so they don't clash with anything already running. Each can be overridden through the variables in `docker-compose.yml`.

If `REDIS_URL` is not set, the nightly accrual schedule simply doesn't start. The API and the tests never need Redis.

## Tests

```bash
docker compose up -d db-test
npm test
```

One command runs everything, including the concurrency tests. It migrates the test database (a throwaway tmpfs Postgres on port 54330), then runs Vitest. Test files run one at a time because they share that database.

The tests that matter most:

| Test                                                                                      | File                     |
| ----------------------------------------------------------------------------------------- | ------------------------ |
| Schedule matches Worked Example 1 to the kobo                                             | `tests/schedule.test.ts` |
| 50 simultaneous requests, same key, one journal entry                                     | `tests/payments.test.ts` |
| 50 parallel payments of 1,000,000 apply exactly 21,063,026 and leave 28,936,974 unapplied | `tests/payments.test.ts` |
| Reversal scenario from the brief (X bounces, Y moves to instalment 1)                     | `tests/reversal.test.ts` |
| Unbalanced, single-line, update and delete attempts straight at the database              | `tests/ledger.test.ts`   |
| Closed-period rejection at API and DB level, reversal after close                         | `tests/period.test.ts`   |
| Reconciliation reports drift per loan                                                     | `tests/period.test.ts`   |

## API

All amounts are integer kobo. Dates are `YYYY-MM-DD`.

| Method | Path                                     | What it does                                                       |
| ------ | ---------------------------------------- | ------------------------------------------------------------------ |
| POST   | `/loans`                                 | Create a loan, return the schedule, post the disbursement entry    |
| GET    | `/loans/:id`                             | Instalment status, payments, allocations and sub-ledger balances   |
| POST   | `/loans/:id/payments`                    | Apply a payment. Requires an `Idempotency-Key` header              |
| POST   | `/loans/:id/payments/:paymentId/reverse` | Reverse a payment and re-allocate later ones                       |
| GET    | `/loans/:id/audit`                       | What changed on the loan, and why                                  |
| POST   | `/invoices/quote`                        | Advance, reserve, discount fee, late penalty, payable or shortfall |
| POST   | `/ledger/entries`                        | Post a manual balanced entry                                       |
| GET    | `/ledger/entries/:id`                    | Fetch one entry with its lines                                     |
| POST   | `/ledger/entries/:id/reverse`            | Linked reversing entry (a second reversal is rejected)             |
| GET    | `/ledger/trial-balance`                  | Per-account debits, credits and net                                |
| POST   | `/jobs/accrue?asOfDate=YYYY-MM-DD`       | Post interest for instalments that have fallen due                 |
| POST   | `/periods/:yyyy-mm/close`                | Lock a month                                                       |
| GET    | `/reconciliation`                        | Loan-level balances versus the control accounts                    |

### Request shapes

```jsonc
// POST /loans
{ "principal": 120000000, "annualRate": "0.18", "termMonths": 6, "disbursementDate": "2026-01-15" }

// POST /loans/:id/payments   (header: Idempotency-Key: <unique per payment>)
{ "amount": 21063026, "paymentDate": "2026-02-15", "externalRef": "BANK-123" }   // externalRef optional

// POST /loans/:id/payments/:paymentId/reverse
{ "reason": "bounced cheque", "date": "2026-03-01" }                              // date optional, defaults to today

// POST /invoices/quote
{ "faceValue": 1000000000, "tenorDays": 60, "daysOverdue": 10 }

// POST /ledger/entries
{ "date": "2026-02-01", "description": "manual", "lines": [
    { "account": "CASH", "side": "D", "amount": 500 },
    { "account": "FEE_INCOME", "side": "C", "amount": 500 } ] }
```

`annualRate` is a decimal fraction string (`"0.18"` means 18%). Floats in amount fields are rejected with a 400.

### Try it

```bash
# 1. Create the Worked Example 1 loan
curl -s localhost:4010/loans -H 'content-type: application/json' \
  -d '{"principal":120000000,"annualRate":"0.18","termMonths":6,"disbursementDate":"2026-01-15"}'

# 2. Pay instalment 1 (use the loan id from step 1)
curl -s localhost:4010/loans/<LOAN_ID>/payments \
  -H 'content-type: application/json' -H 'Idempotency-Key: pay-001' \
  -d '{"amount":21063026,"paymentDate":"2026-02-15"}'

# 3. Send the exact same request again: same response, nothing new posted
curl -si localhost:4010/loans/<LOAN_ID>/payments \
  -H 'content-type: application/json' -H 'Idempotency-Key: pay-001' \
  -d '{"amount":21063026,"paymentDate":"2026-02-15"}'

# 4. Check the books
curl -s localhost:4010/ledger/trial-balance
curl -s localhost:4010/reconciliation
```

## How it works

**The journal is the source of truth.** Every write goes through one function (`postEntry` in `src/modules/ledger/ledger.service.ts`). Instalments, payments and allocations are derived state kept next to it so reads are cheap, and `/reconciliation` checks the two agree.

**The database enforces the accounting rules**, not just the code:

- a deferred constraint trigger rejects any entry where debits don't equal credits, or that has fewer than two lines
- triggers block `UPDATE` and `DELETE` on journal entries, journal lines and the audit table
- a trigger rejects entries dated in a closed period
- money columns are `BIGINT` with `CHECK`s (positive line amounts, non-negative balances)

**Idempotent payments.** The idempotency key is inserted with `ON CONFLICT DO NOTHING` as the first statement of the payment transaction. Concurrent duplicates block on the unique index until the first one commits, then read its stored response.

**Concurrency.** Every payment, reversal and accrual takes `SELECT ... FOR UPDATE` on the loan row first. Work on one loan is strictly serial, in commit order. Different loans never block each other.

**Reversal and re-allocation by replay.** Instead of patching later payments by hand, the engine takes the payments that still count in `(paymentDate, arrival)` order, replays them through the waterfall from scratch, compares the result with what's stored, and posts a delta entry for each payment that changed. The same routine handles new payments, reversals and late arrivals. Every change writes a before/after row to `allocation_audit`.

**Payment waterfall.** Oldest due instalment first. Inside an instalment: penalty, fee, interest, principal. Anything left over becomes Unapplied Credit.

**Period close.** Closing a month rejects any entry dated in it. Corrections are posted in the current open period with a reference to the original entry.

## Known gaps

The full list is in [NOTES.md](./NOTES.md). The main ones: invoice advance/settlement postings are not implemented (only the quote), and there is no auth.

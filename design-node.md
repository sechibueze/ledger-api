# Design note: QuickLend production ledger

## Shape of the thing

The journal is the source of truth. Everything else (instalments, payments, allocations) is derived state that I keep next to it so queries are cheap, and reconciliation is how I check if the two agree.

Every write path goes through one function, `postEntry`. It drops zero lines, checks that the entry balances and that the period is open, then inserts. I didn't want the database to be the only defence, because its errors are ugly, but it is the last one: a deferred constraint trigger checks debits equal credits at commit, triggers reject update and delete on journal tables, and another one refuses inserts into a closed period. A bug in my service code, or someone running SQL by hand, still can't post a bad entry.

## Failure modes I handled

**Duplicate requests.** The idempotency row is inserted with `ON CONFLICT DO NOTHING` as the first statement of the payment transaction. If fifty identical requests arrive
together, one inserts and the rest block on the unique index until it commits. Then they read the stored response. If the first one fails and rolls back, its key row disappears with it and the next waiter takes over. Same key with a different body is a 422, checked by comparing a hash of loan id plus body.

**Parallel payments on one loan.** Row lock on the loan, as described in the notes.
The allocation for payment N always sees payments 1 to N-1 committed. The test with 50 payments checks the totals and that no payment is over- or under-allocated.

**Reversal and what it does to later payments.** I didn't want to write "reverse X,
then patch Y". With a chain of five payments and the middle one reversed, patching
becomes difficult to think about. Instead, every payment, reversal and late arrival runs the same routine: load the payments that still count, in order, replay them through the waterfall from empty, compare to what's stored, and post a delta entry for each payment that changed. The waterfall itself is a pure function, which made it easy to unit test. Each change also writes a before/after row to `allocation_audit` with the reason.

**Double reversal.** Payments check their status under the loan lock. Plain ledger
entries have a unique index on `reverses_entry_id`, so two concurrent reversals can't
both win.

**Closing a period while something is posting.** The close does `LOCK TABLE
journal_entries IN SHARE ROW EXCLUSIVE MODE` first. It waits for in-flight inserts,
and anything arriving after hits the period trigger. It briefly blocks all postings,
which is acceptable once a month.

**Money precision.** `BIGINT` in Postgres, `bigint` in the code, because the annuity
formula goes past 2^53 before the final division. The rate is kept as a numerator and
denominator so the whole instalment is one exact fraction rounded once.

## Failure modes I did not handle

- The accrual job runs loan by loan and records failures in its response, but nothing retries or sends alerts on them.
- Idempotency keys never expire.
- There is no protection against someone adding a balanced pair of lines to an old entry in a new transaction.
- A payment arriving for a closed period is rejected outright. Operations would have to resubmit it with an open date.
- If a payment is recorded against the wrong loan, the fix is reverse and re-enter. I
  didn't build a "move payment" operation.

## Duplicate and out-of-order bank webhooks

Duplicates: the bank's event id should be the `Idempotency-Key`. As a second guard
there's a unique `(loan_id, external_ref)`, so a retry that somehow gets a fresh key is a 409 and not a second payment.

Out of order: the order that matters for allocation is payment date, not arrival
time. If a payment dated 15 Feb turns up after one dated 15 Mar was already processed, the replay puts them in the right order, and the March payment may move to
a different instalment. That posts a re-allocation entry in the open period, pointing
at the original, plus an audit row. Late events never rewrite closed periods.

## Detecting drift in production

`/reconciliation` is the main thing here. It compares per-loan balances from the sub-ledger against journal lines tagged with that loan, and the control account totals against the sum of the loans. Lines on control accounts with no loan id show up as a difference at the account level, which is how I'd catch a manual entry that bypassed loan logic. I'd run it on a schedule and page on any non-zero difference.

Alongside it:

- check that trial balance debits equal credits (the trigger should make that
  impossible, so a failure means the trigger is missing);
- re-run the allocation replay for each loan and compare with stored allocations, which catches bugs in the projection code;
- compare the Cash account against the bank statement, which is the only check that doesn't depend on our own data.

## What changes at 100x volume

The per-loan lock stays fine. Different loans don't contend, and a single loan
getting 50 simultaneous payments is a freak case. What gets worse:

- The replay is O(payments on the loan) every time a payment arrives. For a loan with
  a handful of payments that's nothing, but I'd make the common case incremental
  (apply to current state) and only replay on reversal or out-of-order arrival.
- Requests waiting on a loan lock hold a database connection each, so a burst could
  drain the pool. I'd put payments on a queue keyed by loan id and return 202.
- Reconciliation and the trial balance scan everything. I'd keep per-loan and
  per-account balance rows updated in the same transaction as the posting, and run
  the full comparison against a replica.
- `journal_lines` should be partitioned by month, which lines up with period close.
- The idempotency table needs a cleanup job, or the keys move to Redis with a durable fallback.
- The accrual job should fan out across workers by loan instead of looping in one
  process.

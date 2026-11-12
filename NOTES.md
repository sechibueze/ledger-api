# NOTES

Stack: Node 22, Express 5, TypeScript, Prisma 7, Postgres 17. BullMQ is only used
for an optional nightly accrual schedule, there is nothing that depends on Redis to run the tests.

Run it: `docker compose up -d && npm test`. The test script migrates a separate
test database (port 54330) and runs everything, including the concurrency tests.

## Assumptions

I didn't ask anyone, so these are my readings of the brief.

- `annualRate` is sent as a decimal fraction string, e.g. `"0.18"`. It's parsed into a numerator and denominator, so no float ever touches the maths.
- Ledger lines look like `{ account, side: "D" | "C", amount }`.
- Advance is 80% of face, rounded half-up to the kobo. The brief only names rounding for fee and penalty, but a face value that isn't a multiple of 5 kobo would needs it.
- Payments are replayed in `(paymentDate, arrival order)`. A payment can only reach
  instalments that were due on or before its own date.
- Money left after everything due is cleared stays as Unapplied Credit. I didn't move it onto later instalments automatically, because the brief says it isn't a prepayment.
- Term loans have no penalty or fee rule in the brief. The instalment table has `penalty_due` and `fee_due` columns (default is 0) so the waterfall order is real, but nothing writes to them yet.
- Corrections (payment reversals re-allocations, ledger reversals) are dated today, or a `date` passed in the body. This helps to keeps them out of closed periods.
- If the accrual job or a payment needs to accrue an instalment whose due-date period is already closed, the accrual is posted in the current period instead of failing.
- Idempotency keys are global, not per loan. The hash covers the loan id and the body. Failed requests are not stored, so a retry after a failure runs again.
- Reversing a payment's journal entry through `/ledger/entries/:id/reverse` hands off to the payment reversal. Doing it as a plain mirror entry would leave the loan sub-ledger out of step with the ledger.

## Concurrency choice

Every payment, reversal and accrual starts with `SELECT ... FOR UPDATE` on the loan row. Work on one loan runs one at a time in lock order, different loans don't block
each other. I picked this over serializable transactions because 50 writers hitting the same rows would mostly abort and retry.

## Verified by hand

- Worked Example 1 schedule matches to the kobo, including the 21,063,024 last payment and total interest of 6,378,154.
- Example 2: fee 47,342,466, client payable 152,657,534 on time and 136,657,534 at 10 days late.
- I tried to break the DB guards with raw SQL: unbalanced entry, single line, update, delete, insert into a closed period. All rejected.

## Not done

- Invoice advance and settlement postings. Only `/invoices/quote` exists.
- Nothing stops a _later_ transaction from adding a balanced pair of lines to an old entry. Updates and deletes are blocked, inserts into an existing entry are not.
- `TRUNCATE` isn't blocked by the DB triggers. In production the app role shouldn't have it.
- Money goes out as JSON numbers and throws above 2^53 kobo instead of rounding. This is fine for now, but strings would be safer.
- No auth, no rate limiting, no observability, no pagination on the audit endpoint.
- `/reconciliation` and `/ledger/trial-balance` scan the whole journal.

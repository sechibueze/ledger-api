import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/database/db";
import {
  api,
  createExampleLoan,
  DATES,
  getNetBalance,
  pay,
  resetDb,
} from "./helpers";

beforeEach(resetDb);
afterAll(() => db.$disconnect());

describe("POST /loans/:id/payments", () => {
  it("applies the waterfall and posts one entry following the posting rules", async () => {
    const loan = await createExampleLoan();
    const r = await pay(loan.id, 5000000, DATES.instalment1);
    expect(r.status).toBe(201);
    expect(r.body.data.allocations).toEqual([
      {
        instalmentNumber: 1,
        penalty: 0,
        fee: 0,
        interest: 1800000,
        principal: 3200000,
      },
    ]);

    const entry = (
      await api().get(`/ledger/entries/${r.body.data.journalEntryId}`)
    ).body.data;
    const by = (a: string) =>
      entry.lines.find((line: any) => line.account === a);
    expect(by("CASH")).toMatchObject({ side: "D", amount: 5000000 });
    expect(by("INTEREST_RECEIVABLE")).toMatchObject({
      side: "C",
      amount: 1_800_000,
    });
    expect(by("LOANS_RECEIVABLE")).toMatchObject({
      side: "C",
      amount: 3_200_000,
    });
    expect(entry.lines).toHaveLength(3); // zero lines are not posted
  });

  it("overpayment sits as unapplied credit", async () => {
    const loan = await createExampleLoan();
    const r = await pay(loan.id, 30_000_000, DATES.instalment1);
    expect(r.body.data.unapplied).toBe(30_000_000 - 21_063_026);
    const tb = (await api().get("/ledger/trial-balance")).body.data;
    expect(getNetBalance(tb, "UNAPPLIED_CREDIT")).toBe(
      -(30_000_000 - 21_063_026),
    );
  });

  it("requires an Idempotency-Key and a valid body", async () => {
    const loan = await createExampleLoan();
    expect(
      (
        await api()
          .post(`/loans/${loan.id}/payments`)
          .send({ amount: 100, paymentDate: DATES.instalment1 })
      ).status,
    ).toBe(400);
    expect((await pay(loan.id, 100.5, DATES.instalment1)).status).toBe(400);
    expect((await pay(randomUUID(), 100, DATES.instalment1)).status).toBe(404);
  });
});

describe("idempotency", () => {
  it("same key and body replays the original response and posts nothing new", async () => {
    const loan = await createExampleLoan();
    const key = randomUUID();
    const a = await pay(loan.id, 1_000_000, DATES.disbursement, key);
    const b = await pay(loan.id, 1_000_000, DATES.disbursement, key);
    expect(b.status).toBe(201);
    expect(b.body).toEqual(a.body);
    expect(b.headers["idempotent-replay"]).toBe("true");
    expect(await db.journalEntry.count({ where: { kind: "PAYMENT" } })).toBe(1);
  });

  it("same key with a different body is rejected", async () => {
    const loan = await createExampleLoan();
    const key = randomUUID();
    await pay(loan.id, 1_000_000, DATES.disbursement, key);
    expect(
      (await pay(loan.id, 2_000_000, DATES.disbursement, key)).status,
    ).toBe(422);
  });

  it("50 simultaneous requests with one key produce exactly one journal entry", async () => {
    const loan = await createExampleLoan();
    const key = randomUUID();
    const rs = await Promise.all(
      Array.from({ length: 50 }, () =>
        pay(loan.id, 1_000_000, DATES.disbursement, key),
      ),
    );
    expect(rs.every((r) => r.status === 201)).toBe(true);
    expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
    expect(await db.journalEntry.count({ where: { kind: "PAYMENT" } })).toBe(1);
    expect(await db.payment.count()).toBe(1);
  });

  it("a duplicate bank webhook with a fresh key but the same externalRef is rejected", async () => {
    const loan = await createExampleLoan();
    await pay(loan.id, 1_000_000, DATES.disbursement, randomUUID(), {
      externalRef: "BANK-123",
    });
    expect(
      (
        await pay(loan.id, 1_000_000, DATES.disbursement, randomUUID(), {
          externalRef: "BANK-123",
        })
      ).status,
    ).toBe(409);
    expect(await db.payment.count()).toBe(1);
  });
});

describe("concurrency", () => {
  it("50 parallel payments of 1,000,000 apply exactly 21,063,026 and leave 28,936,974 unapplied", async () => {
    const loan = await createExampleLoan();
    const rs = await Promise.all(
      Array.from({ length: 50 }, () =>
        pay(loan.id, 1_000_000, DATES.instalment1),
      ),
    );
    expect(rs.every((r) => r.status === 201)).toBe(true);

    const view = (await api().get(`/loans/${loan.id}`)).body.data;
    const i1 = view.instalments[0];
    expect(i1.status).toBe("PAID");
    expect(i1.paid.interest + i1.paid.principal).toBe(21_063_026);
    expect(view.balances.unappliedCredit).toBe(28_936_974);
    expect(
      view.instalments.slice(1).every((i: any) => i.status === "UNPAID"),
    ).toBe(true);

    // no double-allocation: allocations sum to the instalment, no payment over-applied
    const allocated = view.payments
      .flatMap((p: any) => p.allocations)
      .reduce((s: number, a: any) => s + a.interest + a.principal, 0);
    expect(allocated).toBe(21_063_026);
    expect(
      view.payments.every(
        (p: any) =>
          p.amount ===
          p.unapplied +
            p.allocations.reduce(
              (s: number, a: any) => s + a.interest + a.principal,
              0,
            ),
      ),
    ).toBe(true);

    const tb = (await api().get("/ledger/trial-balance")).body.data;
    expect(tb.balanced).toBe(true);
    expect(getNetBalance(tb, "UNAPPLIED_CREDIT")).toBe(-28_936_974);
    expect(getNetBalance(tb, "LOANS_RECEIVABLE")).toBe(
      120_000_000 - 19_263_026,
    );
    expect(getNetBalance(tb, "INTEREST_RECEIVABLE")).toBe(0);
    expect(getNetBalance(tb, "CASH")).toBe(-120_000_000 + 50_000_000);
    expect(await db.journalEntry.count({ where: { kind: "PAYMENT" } })).toBe(
      50,
    );
  });
});

describe("out-of-order delivery", () => {
  it("a late-arriving earlier-dated payment re-orders history and posts correcting entries", async () => {
    const loan = await createExampleLoan();
    const later = await pay(loan.id, 21_063_026, DATES.instalment2); // arrives first
    expect(later.body.data.allocations[0].instalmentNumber).toBe(1); // only inst 1 is a candidate... and it is due
    const earlier = await pay(loan.id, 21_063_026, DATES.instalment1); // arrives second, dated D1
    expect(
      earlier.body.data.allocations.map((a: any) => a.instalmentNumber),
    ).toEqual([1]);
    const view = (await api().get(`/loans/${loan.id}`)).body.data;
    const byId = Object.fromEntries(view.payments.map((p: any) => [p.id, p]));
    expect(
      byId[later.body.data.id].allocations.map((a: any) => a.instalmentNumber),
    ).toEqual([2]);
    expect(earlier.body.data.adjustedPayments).toHaveLength(1);
    expect((await api().get("/ledger/trial-balance")).body.data.balanced).toBe(
      true,
    );
  });
});

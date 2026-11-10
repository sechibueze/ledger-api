import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db";
import { api, createExampleLoan, D, net, pay, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

describe("POST /loans/:id/payments", () => {
  it("applies the waterfall and posts one entry following the posting rules", async () => {
    const loan = await createExampleLoan();
    const r = await pay(loan.id, 5_000_000, D.d1);
    expect(r.status).toBe(201);
    expect(r.body.allocations).toEqual([
      {
        instalmentNumber: 1,
        penalty: 0,
        fee: 0,
        interest: 1_800_000,
        principal: 3_200_000,
      },
    ]);

    const entry = (await api().get(`/ledger/entries/${r.body.journalEntryId}`))
      .body;
    const by = (a: string) => entry.lines.find((l: any) => l.account === a);
    expect(by("CASH")).toMatchObject({ side: "D", amount: 5_000_000 });
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
    const r = await pay(loan.id, 30_000_000, D.d1);
    expect(r.body.unapplied).toBe(30_000_000 - 21_063_026);
    const tb = (await api().get("/ledger/trial-balance")).body;
    expect(net(tb, "UNAPPLIED_CREDIT")).toBe(-(30_000_000 - 21_063_026));
  });

  it("requires an Idempotency-Key and a valid body", async () => {
    const loan = await createExampleLoan();
    expect(
      (
        await api()
          .post(`/loans/${loan.id}/payments`)
          .send({ amount: 100, paymentDate: D.d1 })
      ).status,
    ).toBe(400);
    expect((await pay(loan.id, 100.5, D.d1)).status).toBe(400);
    expect((await pay(randomUUID(), 100, D.d1)).status).toBe(404);
  });
});

describe("idempotency", () => {
  it("same key and body replays the original response and posts nothing new", async () => {
    const loan = await createExampleLoan();
    const key = randomUUID();
    const a = await pay(loan.id, 1_000_000, D.d1, key);
    const b = await pay(loan.id, 1_000_000, D.d1, key);
    expect(b.status).toBe(201);
    expect(b.body).toEqual(a.body);
    expect(b.headers["idempotent-replay"]).toBe("true");
    expect(
      await prisma.journalEntry.count({ where: { kind: "PAYMENT" } }),
    ).toBe(1);
  });

  it("same key with a different body is rejected", async () => {
    const loan = await createExampleLoan();
    const key = randomUUID();
    await pay(loan.id, 1_000_000, D.d1, key);
    expect((await pay(loan.id, 2_000_000, D.d1, key)).status).toBe(422);
  });

  it("50 simultaneous requests with one key produce exactly one journal entry", async () => {
    const loan = await createExampleLoan();
    const key = randomUUID();
    const rs = await Promise.all(
      Array.from({ length: 50 }, () => pay(loan.id, 1_000_000, D.d1, key)),
    );
    expect(rs.every((r) => r.status === 201)).toBe(true);
    expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
    expect(
      await prisma.journalEntry.count({ where: { kind: "PAYMENT" } }),
    ).toBe(1);
    expect(await prisma.payment.count()).toBe(1);
  });

  it("a duplicate bank webhook with a fresh key but the same externalRef is rejected", async () => {
    const loan = await createExampleLoan();
    await pay(loan.id, 1_000_000, D.d1, randomUUID(), {
      externalRef: "BANK-123",
    });
    expect(
      (
        await pay(loan.id, 1_000_000, D.d1, randomUUID(), {
          externalRef: "BANK-123",
        })
      ).status,
    ).toBe(409);
    expect(await prisma.payment.count()).toBe(1);
  });
});

describe("concurrency", () => {
  it("50 parallel payments of 1,000,000 apply exactly 21,063,026 and leave 28,936,974 unapplied", async () => {
    const loan = await createExampleLoan();
    const rs = await Promise.all(
      Array.from({ length: 50 }, () => pay(loan.id, 1_000_000, D.d1)),
    );
    expect(rs.every((r) => r.status === 201)).toBe(true);

    const view = (await api().get(`/loans/${loan.id}`)).body;
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

    const tb = (await api().get("/ledger/trial-balance")).body;
    expect(tb.balanced).toBe(true);
    expect(net(tb, "UNAPPLIED_CREDIT")).toBe(-28_936_974);
    expect(net(tb, "LOANS_RECEIVABLE")).toBe(120_000_000 - 19_263_026);
    expect(net(tb, "INTEREST_RECEIVABLE")).toBe(0);
    expect(net(tb, "CASH")).toBe(-120_000_000 + 50_000_000);
    expect(
      await prisma.journalEntry.count({ where: { kind: "PAYMENT" } }),
    ).toBe(50);
  });
});

describe("out-of-order delivery", () => {
  it("a late-arriving earlier-dated payment re-orders history and posts correcting entries", async () => {
    const loan = await createExampleLoan();
    const later = await pay(loan.id, 21_063_026, D.d2); // arrives first, dated D2
    expect(later.body.allocations[0].instalmentNumber).toBe(1); // only inst 1 is a candidate... and it is due
    const earlier = await pay(loan.id, 21_063_026, D.d1); // arrives second, dated D1
    expect(
      earlier.body.allocations.map((a: any) => a.instalmentNumber),
    ).toEqual([1]);
    const view = (await api().get(`/loans/${loan.id}`)).body;
    const byId = Object.fromEntries(view.payments.map((p: any) => [p.id, p]));
    expect(
      byId[later.body.id].allocations.map((a: any) => a.instalmentNumber),
    ).toEqual([2]);
    expect(earlier.body.adjustedPayments).toHaveLength(1);
    expect((await api().get("/ledger/trial-balance")).body.balanced).toBe(true);
  });
});

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

const reverse = (loanId: string, paymentId: string, extra: object = {}) =>
  api()
    .post(`/loans/${loanId}/payments/${paymentId}/reverse`)
    .send({ reason: "bounced cheque", ...extra });

const sums = (payment: any) =>
  payment.allocations.reduce(
    (totals: any, allocation: any) => ({
      interest: totals.interest + allocation.interest,
      principal: totals.principal + allocation.principal,
    }),
    { interest: 0, principal: 0 },
  );

describe("visible scenario (task 4)", () => {
  it("reverses X, re-allocates Y, posts the exact correcting entries", async () => {
    const loan = await createExampleLoan();
    await api().post(`/jobs/accrue?asOfDate=${DATES.instalment2}`);

    const paymentX = (await pay(loan.id, 21_063_026, DATES.instalment1)).body
      .data;
    const paymentY = (await pay(loan.id, 21_063_026, DATES.instalment2)).body
      .data;

    expect(sums(paymentY)).toEqual({
      interest: 1511055,
      principal: 19551971,
    });

    const reversalResponse = await reverse(loan.id, paymentX.id);
    expect(reversalResponse.status).toBe(201);

    const loanView = (await api().get(`/loans/${loan.id}`)).body.data;
    const reversedPayment = loanView.payments.find(
      (payment: any) => payment.id === paymentX.id,
    );
    const reallocatedPayment = loanView.payments.find(
      (payment: any) => payment.id === paymentY.id,
    );

    expect(reversedPayment.status).toBe("REVERSED");
    expect(loanView.instalments[0].status).toBe("PAID");
    expect(loanView.instalments[1].status).toBe("UNPAID");
    expect(sums(reallocatedPayment)).toEqual({
      interest: 1800000,
      principal: 19263026,
    });

    // correcting entries
    const reversalEntry = (
      await api().get(
        `/ledger/entries/${reversalResponse.body.data.adjustments.find((adjustment: any) => adjustment.kind === "PAYMENT_REVERSAL").journalEntryId}`,
      )
    ).body.data;

    const findEntryLine = (entry: any, account: string) =>
      entry.lines.find((entryLine: any) => entryLine.account === account);

    expect(findEntryLine(reversalEntry, "INTEREST_RECEIVABLE")).toMatchObject({
      side: "D",
      amount: 1800000,
    });
    expect(findEntryLine(reversalEntry, "LOANS_RECEIVABLE")).toMatchObject({
      side: "D",
      amount: 19263026,
    });
    expect(findEntryLine(reversalEntry, "CASH")).toMatchObject({
      side: "C",
      amount: 21063026,
    });
    expect(reversalEntry.reference).toBe(paymentX.journalEntryId);

    const reallocationEntry = (
      await api().get(
        `/ledger/entries/${reversalResponse.body.data.adjustments.find((adjustment: any) => adjustment.kind === "REALLOCATION").journalEntryId}`,
      )
    ).body.data;

    expect(
      findEntryLine(reallocationEntry, "INTEREST_RECEIVABLE"),
    ).toMatchObject({
      side: "C",
      amount: 288945,
    });
    expect(findEntryLine(reallocationEntry, "LOANS_RECEIVABLE")).toMatchObject({
      side: "D",
      amount: 288945,
    });
    expect(reallocationEntry.reference).toBe(paymentY.journalEntryId);

    const trialBalance = (await api().get("/ledger/trial-balance")).body.data;
    expect(trialBalance.balanced).toBe(true);
    expect(getNetBalance(trialBalance, "LOANS_RECEIVABLE")).toBe(100736974);
    expect(getNetBalance(trialBalance, "INTEREST_RECEIVABLE")).toBe(1511055);
    expect(loanView.balances.principalOutstanding).toBe(100736974);
    expect(loanView.balances.interestReceivable).toBe(1511055);

    const auditTrail = (await api().get(`/loans/${loan.id}/audit`)).body.data;
    const paymentYChange = auditTrail.find(
      (auditEntry: any) =>
        auditEntry.paymentId === paymentY.id &&
        auditEntry.trigger === "PAYMENT_REVERSED",
    );

    expect(paymentYChange.reason).toContain("bounced cheque");
    expect(paymentYChange.before.allocations[0]).toMatchObject({
      instalment: 2,
      interest: 1511055,
    });
    expect(paymentYChange.after.allocations[0]).toMatchObject({
      instalment: 1,
      interest: 1800000,
    });
  });
});

describe("reversal edge cases", () => {
  it("rejects a double reversal, including concurrent ones", async () => {
    const loan = await createExampleLoan();
    const payment = (await pay(loan.id, 1000000, DATES.instalment1)).body.data;

    const reversalResponses = await Promise.all(
      Array.from({ length: 5 }, () => reverse(loan.id, payment.id)),
    );

    expect(
      reversalResponses.filter((response) => response.status === 201),
    ).toHaveLength(1);
    expect(
      reversalResponses.filter((response) => response.status === 409),
    ).toHaveLength(4);
    expect(
      await db.journalEntry.count({ where: { kind: "PAYMENT_REVERSAL" } }),
    ).toBe(1);
  });

  it("reversing the middle payment of a chain of five shifts the later ones", async () => {
    const loan = await createExampleLoan();
    await api().post(`/jobs/accrue?asOfDate=${DATES.instalment2}`);

    const payments: any[] = [];

    for (const [amount, paymentDate] of [
      [21063026, DATES.instalment1],
      [21063026, DATES.instalment2],
      [21063026, DATES.instalment2],
      [5000000, DATES.instalment3],
      [5_000_000, DATES.instalment3],
    ] as const) {
      payments.push((await pay(loan.id, amount, paymentDate)).body.data);
    }

    expect((await reverse(loan.id, payments[1].id)).status).toBe(201);

    const loanView = (await api().get(`/loans/${loan.id}`)).body.data;

    expect(
      loanView.instalments.map((instalment: any) => instalment.status),
    ).toEqual(["PAID", "PAID", "PARTIAL", "UNPAID", "UNPAID", "UNPAID"]);
    expect((await api().get("/ledger/trial-balance")).body.data.balanced).toBe(
      true,
    );
    expect((await api().get("/reconciliation")).body.data.balanced).toBe(true);
  });

  it("reversing a payment that created unapplied credit removes the credit", async () => {
    const loan = await createExampleLoan();
    const payment = (await pay(loan.id, 30_000_000, DATES.disbursement)).body
      .data;

    await reverse(loan.id, payment.id);

    const trialBalance = (await api().get("/ledger/trial-balance")).body.data;

    expect(getNetBalance(trialBalance, "UNAPPLIED_CREDIT")).toBe(0);
    expect(getNetBalance(trialBalance, "CASH")).toBe(-120_000_000);
    expect((await api().get("/reconciliation")).body.data.balanced).toBe(true);
  });

  it("reversing a payment via the generic ledger endpoint goes through the payment engine", async () => {
    const loan = await createExampleLoan();
    const payment = (await pay(loan.id, 21_063_026, DATES.instalment1)).body
      .data;

    const reversalResponse = await api()
      .post(`/ledger/entries/${payment.journalEntryId}/reverse`)
      .send({});

    expect(reversalResponse.status).toBe(201);
    expect(
      (await api().get(`/loans/${loan.id}`)).body.data.payments[0].status,
    ).toBe("REVERSED");

    expect(
      (
        await api()
          .post(`/ledger/entries/${payment.journalEntryId}/reverse`)
          .send({})
      ).status,
    ).toBe(409);
  });
});

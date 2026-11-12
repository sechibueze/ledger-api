import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/database/db";
import { api, createExampleLoan, getNetBalance, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(() => db.$disconnect());

describe("POST /loans", () => {
  it("returns the Worked Example 1 schedule and posts the disbursement entry", async () => {
    const createdLoan = await createExampleLoan();

    expect(createdLoan.instalmentAmount).toBe(21063026);
    expect(createdLoan.totalInterest).toBe(6378154);
    expect(
      createdLoan.schedule.map((instalment) => instalment.payment),
    ).toEqual([21063026, 21063026, 21063026, 21063026, 21063026, 21063024]);
    expect(createdLoan.schedule[5].closingBalance).toBe(0);

    const trialBalance = (await api().get("/ledger/trial-balance")).body.data;

    expect(getNetBalance(trialBalance, "LOANS_RECEIVABLE")).toBe(120000000);
    expect(getNetBalance(trialBalance, "CASH")).toBe(-120000000);
    expect(trialBalance.balanced).toBe(true);
  });

  it("rejects float principal and bad rates", async () => {
    const validLoanInput = {
      principal: 120000000,
      annualRate: "0.18",
      termMonths: 6,
      disbursementDate: "2026-01-15",
    };

    expect(
      (
        await api()
          .post("/loans")
          .send({ ...validLoanInput, principal: 1000.5 })
      ).status,
    ).toBe(400);

    expect(
      (
        await api()
          .post("/loans")
          .send({ ...validLoanInput, annualRate: "18%" })
      ).status,
    ).toBe(400);

    expect(
      (
        await api()
          .post("/loans")
          .send({ ...validLoanInput, termMonths: 0 })
      ).status,
    ).toBe(400);
  });

  it("handles a zero-interest loan: equal principal, final row clears the balance", async () => {
    const response = await api().post("/loans").send({
      principal: 1000001,
      annualRate: "0",
      termMonths: 4,
      disbursementDate: "2026-01-31",
    });

    expect(response.status).toBe(201);
    expect(response.body.data.schedule[3].closingBalance).toBe(0);
    expect(response.body.data.schedule[1].dueDate).toBe("2026-03-31");
    expect(response.body.data.schedule[0].dueDate).toBe("2026-02-28");
  });
});

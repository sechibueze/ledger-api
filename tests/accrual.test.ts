import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/database/db";
import {
  api,
  createExampleLoan,
  DATES,
  getNetBalance,
  resetDb,
} from "./helpers";

beforeEach(resetDb);
afterAll(() => db.$disconnect());

describe("POST /jobs/accrue", () => {
  it("accrues only instalments that have fallen due, and only once", async () => {
    await createExampleLoan();

    const firstAccrualResponse = await api().post(
      `/jobs/accrue?asOfDate=${DATES.instalment2}`,
    );
    expect(firstAccrualResponse.body.data.instalmentsAccrued).toBe(2);

    const trialBalance = (await api().get("/ledger/trial-balance")).body.data;
    expect(getNetBalance(trialBalance, "INTEREST_RECEIVABLE")).toBe(
      1800000 + 1511055,
    );
    expect(getNetBalance(trialBalance, "INTEREST_INCOME")).toBe(
      -(1800000 + 1511055),
    );

    const repeatedAccrualResponse = await api().post(
      `/jobs/accrue?asOfDate=${DATES.instalment2}`,
    );

    expect(repeatedAccrualResponse.body.data.instalmentsAccrued).toBe(0); // idempotent

    const subsequentAccrualResponse = await api().post(
      `/jobs/accrue?asOfDate=${DATES.instalment3}`,
    );
    expect(subsequentAccrualResponse.body.data.instalmentsAccrued).toBe(1);
  });

  it("is safe to run concurrently", async () => {
    await createExampleLoan();

    await Promise.all(
      Array.from({ length: 5 }, () =>
        api().post(`/jobs/accrue?asOfDate=${DATES.instalment2}`),
      ),
    );

    const accrualJournalEntryCount = await db.journalEntry.count({
      where: { kind: "ACCRUAL" },
    });

    expect(accrualJournalEntryCount).toBe(2);
  });

  it("rejects a bad date", async () => {
    const response = await api().post("/jobs/accrue?asOfDate=2026-13-01");
    expect(response.status).toBe(400);
  });
});

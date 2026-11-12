import { randomUUID } from "node:crypto";
import request from "supertest";
import { app } from "../src/app";
import { db } from "../src/database/db";

export const api = () => request(app);

// TRUNCATE will not fire row-level triggers
export async function resetDb() {
  await db.$executeRawUnsafe(
    `TRUNCATE journal_lines, journal_entries, payment_allocations, allocation_audit, payments,
              instalments, loans, periods, idempotency_keys RESTART IDENTITY CASCADE`,
  );
}

export const DATES = {
  disbursement: "2026-01-15",
  instalment1: "2026-02-15",
  instalment2: "2026-03-15",
  instalment3: "2026-04-15",
};

export async function createExampleLoan(
  loanDisbursementDate = DATES.disbursement,
) {
  const response = await api().post("/loans").send({
    principal: 120_000_000,
    annualRate: "0.18",
    termMonths: 6,
    disbursementDate: loanDisbursementDate,
  });

  if (response.status !== 201)
    throw new Error(`loan create failed: ${JSON.stringify(response.body)}`);

  return response.body.data as {
    id: string;
    instalmentAmount: number;
    totalInterest: number;
    schedule: any[];
  };
}

export const pay = (
  loanId: string,
  amount: number,
  paymentDate: string,
  idempotencyKey: string = randomUUID(),
  additionalFields: object = {},
) =>
  api()
    .post(`/loans/${loanId}/payments`)
    .set("Idempotency-Key", idempotencyKey)
    .send({ amount, paymentDate, ...additionalFields });

export const getNetBalance = (
  trialBalance: any,
  accountCode: string,
): number => {
  let found = trialBalance.accounts.find(
    (account: any) => account.code === accountCode,
  );
  return Number(found.netBalance);
};

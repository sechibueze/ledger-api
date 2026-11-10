import { db, Tx } from "../../database/db";
import { fmt, toDate } from "../../lib/date";
import { AppError } from "../../lib/errors";
import { parseRate } from "../../lib/money";
import { postEntry } from "../ledger/ledger.service";
import { buildLoanSchedule } from "./loan.calculator";
import type { CreateLoanInput } from "./loan.schemas";

/** Serialises everything that touches one loan: payments, reversals, accrual. */
export async function lockLoan(tx: Tx, loanId: string) {
  const loanRows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM loans WHERE id = ${loanId}::uuid FOR UPDATE`;

  if (loanRows.length === 0)
    throw new AppError("Loan not found", 404, "LOAN_NOT_FOUND");
}

export async function createLoan(input: CreateLoanInput) {
  const principal = BigInt(input.principal);
  const interestRate = parseRate(input.annualRate);

  const repaymentSchedule = buildLoanSchedule(
    principal,
    interestRate,
    input.termMonths,
    input.disbursementDate,
  );

  return db.$transaction(async (tx) => {
    const loan = await tx.loan.create({
      data: {
        principal,
        rateNum: interestRate.num,
        rateDen: interestRate.den,
        annualRate: String(input.annualRate),
        termMonths: input.termMonths,
        disbursementDate: toDate(input.disbursementDate),
        instalmentAmount: repaymentSchedule[0].payment,
      },
    });

    await tx.instalment.createMany({
      data: repaymentSchedule.map((instalment) => ({
        loanId: loan.id,
        number: instalment.number,
        dueDate: toDate(instalment.dueDate),
        principalDue: instalment.principal,
        interestDue: instalment.interest,
      })),
    });

    await postEntry(tx, {
      date: input.disbursementDate,
      description: `Disbursement of loan ${loan.id}`,
      kind: "DISBURSEMENT",
      loanId: loan.id,
      lines: [
        { account: "LOANS_RECEIVABLE", side: "D", amount: principal },
        { account: "CASH", side: "C", amount: principal },
      ],
    });

    return {
      id: loan.id,
      principal,
      annualRate: loan.annualRate,
      termMonths: loan.termMonths,
      disbursementDate: input.disbursementDate,
      instalmentAmount: loan.instalmentAmount,
      totalInterest: repaymentSchedule.reduce(
        (total, instalment) => total + instalment.interest,
        0n,
      ),
      schedule: repaymentSchedule,
    };
  });
}

export async function getLoanView(loanId: string) {
  const loan = await db.loan.findUnique({
    where: { id: loanId },
    include: {
      instalments: { orderBy: { number: "asc" } },
      payments: {
        orderBy: { seq: "asc" },
        include: { allocations: { include: { instalment: true } } },
      },
    },
  });

  if (!loan) throw new AppError("Loan not found", 404, "LOAN_NOT_FOUND");

  const instalmentPayments = new Map<
    string,
    { penalty: bigint; fee: bigint; interest: bigint; principal: bigint }
  >();

  for (const payment of loan.payments) {
    for (const allocation of payment.allocations) {
      const instalmentPaid = instalmentPayments.get(
        allocation.instalmentId,
      ) ?? {
        penalty: 0n,
        fee: 0n,
        interest: 0n,
        principal: 0n,
      };

      instalmentPaid.penalty += allocation.penalty;
      instalmentPaid.fee += allocation.fee;
      instalmentPaid.interest += allocation.interest;
      instalmentPaid.principal += allocation.principal;

      instalmentPayments.set(allocation.instalmentId, instalmentPaid);
    }
  }

  let totalPrincipalPaid = 0n,
    totalInterestPaid = 0n,
    totalInterestAccrued = 0n,
    totalUnappliedCredit = 0n;

  const instalments = loan.instalments.map((instalment) => {
    const instalmentPaid = instalmentPayments.get(instalment.id) ?? {
      penalty: 0n,
      fee: 0n,
      interest: 0n,
      principal: 0n,
    };

    const totalDue =
      instalment.principalDue +
      instalment.interestDue +
      instalment.penaltyDue +
      instalment.feeDue;

    const totalPaid =
      instalmentPaid.penalty +
      instalmentPaid.fee +
      instalmentPaid.interest +
      instalmentPaid.principal;

    totalPrincipalPaid += instalmentPaid.principal;
    totalInterestPaid += instalmentPaid.interest;

    if (instalment.interestAccruedAt) {
      totalInterestAccrued += instalment.interestDue;
    }

    return {
      number: instalment.number,
      dueDate: fmt(instalment.dueDate),
      principalDue: instalment.principalDue,
      interestDue: instalment.interestDue,
      penaltyDue: instalment.penaltyDue,
      feeDue: instalment.feeDue,
      interestAccrued: instalment.interestAccruedAt !== null,
      paid: instalmentPaid,
      status:
        totalPaid === totalDue
          ? "PAID"
          : totalPaid === 0n
            ? "UNPAID"
            : "PARTIAL",
    };
  });

  const payments = loan.payments.map((payment) => {
    if (payment.status === "APPLIED") {
      totalUnappliedCredit += payment.unapplied;
    }

    return {
      id: payment.id,
      seq: payment.seq,
      amount: payment.amount,
      paymentDate: fmt(payment.paymentDate),
      status: payment.status,
      unapplied: payment.unapplied,
      journalEntryId: payment.journalEntryId,
      allocations: payment.allocations
        .sort(
          (allocationA, allocationB) =>
            allocationA.instalment.number - allocationB.instalment.number,
        )
        .map((allocation) => ({
          instalmentNumber: allocation.instalment.number,
          penalty: allocation.penalty,
          fee: allocation.fee,
          interest: allocation.interest,
          principal: allocation.principal,
        })),
    };
  });

  return {
    id: loan.id,
    principal: loan.principal,
    annualRate: loan.annualRate,
    termMonths: loan.termMonths,
    disbursementDate: fmt(loan.disbursementDate),
    instalmentAmount: loan.instalmentAmount,
    balances: {
      principalOutstanding: loan.principal - totalPrincipalPaid,
      interestReceivable: totalInterestAccrued - totalInterestPaid,
      unappliedCredit: totalUnappliedCredit,
    },
    instalments,
    payments,
  };
}

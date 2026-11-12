import { db, Tx } from "../../database/db";
import { fmt as formatDate, today, toDate } from "../../lib/date";
import { isPeriodClosed, postEntry } from "../ledger/ledger.service";
import { lockLoan } from "../loans/loan.service";

/**
 * A late accrual whose due-date period is already closed is posted in the current period.
 */
export async function accrueLoanTx(
  tx: Tx,
  loanId: string,
  asOfDate: string,
): Promise<number> {
  const pendingInstalments = await tx.instalment.findMany({
    where: {
      loanId,
      interestAccruedAt: null,
      dueDate: { lte: toDate(asOfDate) },
    },
    orderBy: { number: "asc" },
  });

  for (const instalment of pendingInstalments) {
    if (instalment.interestDue > 0n) {
      const dueDate = formatDate(instalment.dueDate);
      const postingDate = (await isPeriodClosed(tx, dueDate))
        ? today()
        : dueDate;

      await postEntry(tx, {
        date: postingDate,
        description: `Interest accrual, instalment ${instalment.number}`,
        kind: "ACCRUAL",
        reference: instalment.id,
        loanId,
        lines: [
          {
            account: "INTEREST_RECEIVABLE",
            side: "D",
            amount: instalment.interestDue,
          },
          {
            account: "INTEREST_INCOME",
            side: "C",
            amount: instalment.interestDue,
          },
        ],
      });
    }

    await tx.instalment.update({
      where: { id: instalment.id },
      data: { interestAccruedAt: new Date() },
    });
  }

  return pendingInstalments.length;
}

export async function runAccrual(asOfDate: string) {
  const loansWithPendingAccruals = await db.$queryRaw<{ loan_id: string }[]>`
    SELECT DISTINCT loan_id FROM instalments
    WHERE interest_accrued_at IS NULL AND due_date <= ${asOfDate}::date`;

  let instalmentsAccrued = 0;
  const failures: { loanId: string; error: string }[] = [];

  if (!loansWithPendingAccruals.length) {
    return {
      asOfDate,
      loansProcessed: loansWithPendingAccruals.length - failures.length,
      instalmentsAccrued,
      failures,
    };
  }

  for (const { loan_id: loanId } of loansWithPendingAccruals) {
    try {
      instalmentsAccrued += await db.$transaction(async (tx) => {
        await lockLoan(tx, loanId);
        return accrueLoanTx(tx, loanId, asOfDate);
      });
    } catch (error) {
      console.log("accrual error", error);
      failures.push({ loanId, error: (error as Error).message });
    }

    return {
      asOfDate,
      loansProcessed: loansWithPendingAccruals.length - failures.length,
      instalmentsAccrued,
      failures,
    };
  }
}

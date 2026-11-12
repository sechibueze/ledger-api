import { isUniqueViolation, db, Tx } from "../../database/db";
import { fmt as formatDate, toDate, today } from "../../lib/date";
import { AppError } from "../../lib/errors";

export const ACCOUNT_CODES = [
  "CASH",
  "LOANS_RECEIVABLE",
  "INTEREST_RECEIVABLE",
  "INVOICE_RECEIVABLES",
  "CLIENT_RECEIVABLE",
  "INTEREST_INCOME",
  "FEE_INCOME",
  "PENALTY_INCOME",
  "CLIENT_PAYABLE",
  "UNAPPLIED_CREDIT",
] as const;
export type AccountCode = (typeof ACCOUNT_CODES)[number];

export interface LineInput {
  account: AccountCode;
  side: "D" | "C";
  amount: bigint;
  loanId?: string;
}
export interface PostEntryInput {
  date: string;
  description: string;
  kind: string;
  reference?: string;
  reversesEntryId?: string;
  loanId?: string;
  paymentId?: string;
  lines: LineInput[];
}

export async function isPeriodClosed(transaction: Tx, date: string) {
  return (
    (await transaction.period.findUnique({
      where: { period: date.slice(0, 7) },
    })) !== null
  );
}

/** The only write path into the journal. */
export async function postEntry(transaction: Tx, entryInput: PostEntryInput) {
  if (entryInput.lines.some((line) => line.amount < 0n))
    throw new AppError("Line amounts must be positive", 422, "NEGATIVE_AMOUNT");

  const nonZeroLines = entryInput.lines.filter((line) => line.amount !== 0n);
  if (nonZeroLines.length < 2)
    throw new AppError(
      "An entry needs at least two non-zero lines",
      422,
      "ENTRY_TOO_FEW_LINES",
    );

  const getSideTotal = (entrySide: "D" | "C") =>
    nonZeroLines
      .filter((line) => line.side === entrySide)
      .reduce((total, line) => total + line.amount, 0n);

  if (getSideTotal("D") !== getSideTotal("C")) {
    throw new AppError(
      `Debits ${getSideTotal("D")} must equal credits ${getSideTotal("C")}`,
      422,
      "ENTRY_UNBALANCED",
    );
  }

  if (await isPeriodClosed(transaction, entryInput.date)) {
    throw new AppError(
      `Period ${entryInput.date.slice(0, 7)} is closed`,
      422,
      "PERIOD_CLOSED",
    );
  }

  const entry = await transaction.journalEntry.create({
    data: {
      entryDate: toDate(entryInput.date),
      description: entryInput.description,
      kind: entryInput.kind,
      reference: entryInput.reference,
      reversesEntryId: entryInput.reversesEntryId,
      loanId: entryInput.loanId,
      paymentId: entryInput.paymentId,
    },
  });

  await transaction.journalLine.createMany({
    data: nonZeroLines.map((line) => ({
      entryId: entry.id,
      accountCode: line.account,
      side: line.side,
      amount: line.amount,
      loanId: line.loanId ?? entryInput.loanId ?? null,
    })),
  });

  return entry;
}

export async function getEntry(entryId: string) {
  const entry = await db.journalEntry.findUnique({
    where: { id: entryId },
    include: { lines: true, reversedBy: { select: { id: true } } },
  });

  if (!entry)
    throw new AppError("Journal entry not found", 404, "ENTRY_NOT_FOUND");

  return {
    id: entry.id,
    date: formatDate(entry.entryDate),
    description: entry.description,
    kind: entry.kind,
    reference: entry.reference,
    reversesEntryId: entry.reversesEntryId,
    reversedByEntryId: entry.reversedBy?.id ?? null,
    loanId: entry.loanId,
    paymentId: entry.paymentId,
    lines: entry.lines.map((line) => ({
      account: line.accountCode,
      side: line.side,
      amount: line.amount,
      loanId: line.loanId,
    })),
  };
}

/** Linked reversing entry: same lines, opposite sides, posted in an open period (default: today). */
export async function reverseEntry(
  entryId: string,
  options: { date?: string; reason?: string },
) {
  try {
    return await db.$transaction(async (transaction) => {
      const originalEntry = await transaction.journalEntry.findUnique({
        where: { id: entryId },
        include: { lines: true },
      });

      if (!originalEntry)
        throw new AppError("Journal entry not found", 404, "ENTRY_NOT_FOUND");

      if (
        await transaction.journalEntry.findUnique({
          where: { reversesEntryId: entryId },
        })
      ) {
        throw new AppError(
          "Entry has already been reversed",
          409,
          "ALREADY_REVERSED",
        );
      }

      return postEntry(transaction, {
        date: options.date ?? today(),
        description: `Reversal of ${entryId}${options.reason ? `: ${options.reason}` : ""}`,
        kind: "REVERSAL",
        reference: entryId,
        reversesEntryId: entryId,
        loanId: originalEntry.loanId ?? undefined,
        lines: originalEntry.lines.map((line) => ({
          account: line.accountCode as AccountCode,
          side: line.side === "D" ? "C" : "D",
          amount: line.amount,
          loanId: line.loanId ?? undefined,
        })),
      });
    });
  } catch (error) {
    if (isUniqueViolation(error))
      throw new AppError(
        "Entry has already been reversed",
        409,
        "ALREADY_REVERSED",
      );

    throw error;
  }
}

export async function trialBalance() {
  const accountBalances = await db.$queryRaw<
    {
      code: string;
      name: string;
      type: string;
      debits: bigint;
      credits: bigint;
    }[]
  >`
    SELECT a.code, a.name, a.type,
           COALESCE(SUM(l.amount) FILTER (WHERE l.side = 'D'), 0)::bigint AS debits,
           COALESCE(SUM(l.amount) FILTER (WHERE l.side = 'C'), 0)::bigint AS credits
    FROM accounts a LEFT JOIN journal_lines l ON l.account_code = a.code
    GROUP BY a.code, a.name, a.type ORDER BY a.code`;

  const accounts = accountBalances.map((account) => ({
    ...account,
    netBalance: account.debits - account.credits,
  }));

  const totalDebits = accounts.reduce(
    (total, account) => total + account.debits,
    0n,
  );

  const totalCredits = accounts.reduce(
    (total, account) => total + account.credits,
    0n,
  );

  return {
    accounts,
    totalDebits,
    totalCredits,
    balanced: totalDebits === totalCredits,
  };
}

import { Tx } from "../../database/db";
import { fmt as formatDate } from "../../lib/date";
import { AccountCode, LineInput, postEntry } from "../ledger/ledger.service";
import {
  COMPONENTS,
  Comp,
  computeAllocations,
  Plan,
  zeroComp,
} from "./allocation";

export interface ReallocateOpts {
  triggerPaymentId: string;
  kind: "CREATED" | "REVERSED";
  entryDate: string;
  reason: string;
}

const getTotalAllocations = (allocations: Map<string, Comp>): Comp => {
  const totals = zeroComp();
  for (const allocation of allocations.values()) {
    for (const component of COMPONENTS)
      totals[component] += allocation[component];
  }
  return totals;
};

const samePlan = (
  previousAllocations: Map<string, Comp>,
  previousUnapplied: bigint,
  nextPlan: Plan,
) => {
  if (
    previousUnapplied !== nextPlan.unapplied ||
    previousAllocations.size !== nextPlan.allocations.size
  ) {
    return false;
  }

  for (const [instalmentId, nextAllocation] of nextPlan.allocations) {
    const previousAllocation = previousAllocations.get(instalmentId);
    if (
      !previousAllocation ||
      COMPONENTS.some(
        (component) =>
          previousAllocation[component] !== nextAllocation[component],
      )
    ) {
      return false;
    }
  }

  return true;
};

/** positive credits the account, negative debits account */
function deltaLines(
  cashDelta: bigint,
  allocationDelta: Comp & { unapplied: bigint },
): LineInput[] {
  const lines: LineInput[] = [];

  if (cashDelta > 0n)
    lines.push({ account: "CASH", side: "D", amount: cashDelta });
  if (cashDelta < 0n)
    lines.push({ account: "CASH", side: "C", amount: -cashDelta });

  const accountDeltas: [AccountCode, bigint][] = [
    ["INTEREST_RECEIVABLE", allocationDelta.interest],
    ["LOANS_RECEIVABLE", allocationDelta.principal],
    ["PENALTY_INCOME", allocationDelta.penalty],
    ["FEE_INCOME", allocationDelta.fee],
    ["UNAPPLIED_CREDIT", allocationDelta.unapplied],
  ];

  for (const [account, amount] of accountDeltas) {
    if (amount > 0n) lines.push({ account, side: "C", amount });
    if (amount < 0n) lines.push({ account, side: "D", amount: -amount });
  }

  return lines;
}

const snapshot = (
  allocations: Map<string, Comp>,
  unappliedAmount: bigint,
  instalmentNumbers: Map<string, number>,
) => ({
  allocations: [...allocations]
    .map(([instalmentId, allocation]) => ({
      instalment: instalmentNumbers.get(instalmentId)!,
      penalty: Number(allocation.penalty),
      fee: Number(allocation.fee),
      interest: Number(allocation.interest),
      principal: Number(allocation.principal),
    }))
    .sort((first, second) => first.instalment - second.instalment),
  unapplied: Number(unappliedAmount),
});

/** Caller must hold the loan lock. Returns the correcting entries posted. */
export async function reallocate(tx: Tx, loanId: string, opts: ReallocateOpts) {
  const instalments = await tx.instalment.findMany({
    where: { loanId },
    orderBy: { number: "asc" },
  });

  const instalmentNumbers = new Map(
    instalments.map((instalment) => [instalment.id, instalment.number]),
  );

  const payments = await tx.payment.findMany({
    where: { loanId },
    orderBy: [{ paymentDate: "asc" }, { seq: "asc" }],
    include: { allocations: true },
  });

  const allocationPlans = computeAllocations(
    instalments.map((instalment) => ({
      id: instalment.id,
      dueDate: formatDate(instalment.dueDate),
      penalty: instalment.penaltyDue,
      fee: instalment.feeDue,
      interest: instalment.interestDue,
      principal: instalment.principalDue,
    })),
    payments
      .filter((payment) => payment.status === "APPLIED")
      .map((payment) => ({
        id: payment.id,
        amount: payment.amount,
        paymentDate: formatDate(payment.paymentDate),
      })),
  );

  const postedEntries: {
    paymentId: string;
    journalEntryId: string | null;
    kind: string;
  }[] = [];

  for (const payment of payments) {
    const isNewPayment =
      opts.kind === "CREATED" && payment.id === opts.triggerPaymentId;
    const isReversedPayment =
      opts.kind === "REVERSED" && payment.id === opts.triggerPaymentId;

    const nextPlan: Plan = allocationPlans.get(payment.id) ?? {
      allocations: new Map(),
      unapplied: 0n,
    };

    const previousAllocations = new Map<string, Comp>(
      payment.allocations.map((allocation) => [
        allocation.instalmentId,
        {
          penalty: allocation.penalty,
          fee: allocation.fee,
          interest: allocation.interest,
          principal: allocation.principal,
        },
      ]),
    );

    const previousUnapplied = isNewPayment ? 0n : payment.unapplied;

    if (
      !isNewPayment &&
      !isReversedPayment &&
      samePlan(previousAllocations, previousUnapplied, nextPlan)
    ) {
      continue;
    }

    const nextTotals = getTotalAllocations(nextPlan.allocations);
    const previousTotals = getTotalAllocations(previousAllocations);

    const allocationDelta = {
      penalty: nextTotals.penalty - previousTotals.penalty,
      fee: nextTotals.fee - previousTotals.fee,
      interest: nextTotals.interest - previousTotals.interest,
      principal: nextTotals.principal - previousTotals.principal,
      unapplied: nextPlan.unapplied - previousUnapplied,
    };

    const cashDelta = isNewPayment
      ? payment.amount
      : isReversedPayment
        ? -payment.amount
        : 0n;

    await tx.paymentAllocation.deleteMany({
      where: { paymentId: payment.id },
    });

    if (nextPlan.allocations.size > 0) {
      await tx.paymentAllocation.createMany({
        data: [...nextPlan.allocations].map(([instalmentId, allocation]) => ({
          paymentId: payment.id,
          instalmentId,
          ...allocation,
        })),
      });
    }

    await tx.payment.update({
      where: { id: payment.id },
      data: { unapplied: nextPlan.unapplied },
    });

    const journalLines = deltaLines(cashDelta, allocationDelta);
    let journalEntryId: string | null = null;

    if (journalLines.length > 0) {
      const journalEntry = await postEntry(
        tx,
        isNewPayment
          ? {
              date: formatDate(payment.paymentDate),
              kind: "PAYMENT",
              description: `Payment ${payment.id}`,
              loanId,
              paymentId: payment.id,
              lines: journalLines,
            }
          : {
              date: opts.entryDate,
              kind: isReversedPayment ? "PAYMENT_REVERSAL" : "REALLOCATION",
              description: isReversedPayment
                ? `Reversal of payment ${payment.id}`
                : `Re-allocation of payment ${payment.id}: ${opts.reason}`,
              // points at the original payment entry
              reference: payment.journalEntryId ?? undefined,
              loanId,
              paymentId: payment.id,
              lines: journalLines,
            },
      );

      journalEntryId = journalEntry.id;

      if (isNewPayment) {
        await tx.payment.update({
          where: { id: payment.id },
          data: { journalEntryId: journalEntry.id },
        });
      }
    }

    await tx.allocationAudit.create({
      data: {
        loanId,
        paymentId: payment.id,
        triggerPaymentId: opts.triggerPaymentId,
        trigger:
          opts.kind === "CREATED" ? "PAYMENT_CREATED" : "PAYMENT_REVERSED",
        reason: opts.reason,
        before: snapshot(
          previousAllocations,
          previousUnapplied,
          instalmentNumbers,
        ),
        after: snapshot(
          nextPlan.allocations,
          nextPlan.unapplied,
          instalmentNumbers,
        ),
        journalEntryId,
      },
    });

    postedEntries.push({
      paymentId: payment.id,
      journalEntryId,
      kind: isNewPayment
        ? "PAYMENT"
        : isReversedPayment
          ? "PAYMENT_REVERSAL"
          : "REALLOCATION",
    });
  }

  return postedEntries;
}

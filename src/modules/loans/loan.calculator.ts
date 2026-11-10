import { addMonths } from "../../lib/date";
import { Rate, roundDiv } from "../../lib/money";

export interface ScheduleRow {
  number: number;
  dueDate: string;
  payment: bigint;
  interest: bigint;
  principal: bigint;
  closingBalance: bigint;
}

/**
 * Annuity: instalment = P*i / (1 - (1+i)^-n) with i = N/D,
 *   = P*N*(D+N)^n / (D * ((D+N)^n - D^n)), rounded half-up ONCE.
 */
export function buildLoanSchedule(
  principal: bigint,
  rate: Rate,
  numberOfMonths: number,
  disbursementDate: string,
): ScheduleRow[] {
  const annualRateDenominator = rate.den * 12n;
  const annualRateNumerator = rate.num;
  const repaymentPeriods = BigInt(numberOfMonths);

  let monthlyInstalment: bigint;

  if (annualRateNumerator === 0n) {
    monthlyInstalment = roundDiv(principal, repaymentPeriods);
  } else {
    const compoundedNumerator =
      (annualRateDenominator + annualRateNumerator) ** repaymentPeriods;
    const compoundedDenominator = annualRateDenominator ** repaymentPeriods;

    monthlyInstalment = roundDiv(
      principal * annualRateNumerator * compoundedNumerator,
      annualRateDenominator * (compoundedNumerator - compoundedDenominator),
    );
  }

  const schedule: ScheduleRow[] = [];
  let outstandingBalance = principal;

  for (
    let instalmentNumber = 1;
    instalmentNumber <= numberOfMonths;
    instalmentNumber++
  ) {
    const interestAmount = roundDiv(
      outstandingBalance * annualRateNumerator,
      annualRateDenominator,
    );

    const isFinalInstalment = instalmentNumber === numberOfMonths;

    const principalAmount = isFinalInstalment
      ? outstandingBalance
      : monthlyInstalment - interestAmount;

    outstandingBalance -= principalAmount;

    schedule.push({
      number: instalmentNumber,
      dueDate: addMonths(disbursementDate, instalmentNumber),
      payment: principalAmount + interestAmount,
      interest: interestAmount,
      principal: principalAmount,
      closingBalance: outstandingBalance,
    });
  }

  return schedule;
}

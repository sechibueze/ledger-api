import { z } from "zod";
import { addDays, daysBetween } from "../../lib/date";
import { roundDiv } from "../../lib/money";
import { isoDate, kobo } from "../../lib/schemas";

export const quoteInvoiceSchema = z.object({
  faceValue: kobo,
  tenorDays: z.number().int().positive(),
  daysOverdue: z.number().int().min(0).optional(),
  // Alternative to daysOverdue.
  advanceDate: isoDate.optional(),
  paymentDate: isoDate.optional(),
});

export type QuoteInvoiceInput = z.infer<typeof quoteInvoiceSchema>;

export function quoteInvoice(input: QuoteInvoiceInput) {
  const invoiceFaceValue = BigInt(input.faceValue);
  const invoiceTenorDays = BigInt(input.tenorDays);

  let overdueDays = input.daysOverdue ?? 0;

  if (
    input.daysOverdue === undefined &&
    input.advanceDate &&
    input.paymentDate
  ) {
    const invoiceDueDate = addDays(input.advanceDate, input.tenorDays);

    overdueDays = Math.max(0, daysBetween(input.paymentDate, invoiceDueDate));
  }

  const advanceAmount = roundDiv(invoiceFaceValue * 80n, 100n); // 80%

  const reserveAmount = invoiceFaceValue - advanceAmount;

  const discountFee = roundDiv(
    advanceAmount * 36n * invoiceTenorDays,
    100n * 365n,
  ); // 36% p.a., actual/365

  const latePaymentPenalty = roundDiv(
    advanceAmount * 2n * BigInt(overdueDays),
    1000n,
  ); // 0.2% per day

  const totalCharges = discountFee + latePaymentPenalty;

  return {
    faceValue: invoiceFaceValue,
    advance: advanceAmount,
    reserve: reserveAmount,
    discountFee,
    latePenalty: latePaymentPenalty,
    daysOverdue: overdueDays,
    payableToClient:
      reserveAmount > totalCharges ? reserveAmount - totalCharges : 0n,
    shortfall: totalCharges > reserveAmount ? totalCharges - reserveAmount : 0n,
  };
}

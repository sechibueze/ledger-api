import { z } from "zod";
import { isoDate, kobo } from "../../lib/schemas";

export const createPaymentSchema = z.object({
  amount: kobo,
  paymentDate: isoDate.optional(), // defaults to today
  // bank's event/reference id
  externalRef: z.string().min(1).max(200).optional(),
});
export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;

export const reversePaymentSchema = z.object({
  reason: z.string().min(1).default("Reversed"),
  // date for correcting entries; defaults to today (open period)
  date: isoDate.optional(),
});
export type ReversePaymentInput = z.infer<typeof reversePaymentSchema>;

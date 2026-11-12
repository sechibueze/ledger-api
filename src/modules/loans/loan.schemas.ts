import { z } from "zod";
import { parseRate } from "../../lib/money";
import { isoDate, kobo } from "../../lib/schemas";

export const createLoanSchema = z.object({
  principal: kobo,
  // Decimal fraction as string or number: "0.18" = 18% p.a. No floats are ever computed with.
  annualRate: z.union([z.string(), z.number()]).refine((v) => {
    if (!/^\d+(\.\d+)?$/.test(String(v))) return false;
    const r = parseRate(v);
    return r.num <= r.den;
  }, 'annualRate must be a decimal fraction between 0 and 1, e.g. "0.18"'),
  termMonths: z.number().int().min(1).max(360),
  disbursementDate: isoDate,
});
export type CreateLoanInput = z.infer<typeof createLoanSchema>;

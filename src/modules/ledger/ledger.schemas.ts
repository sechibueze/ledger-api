import { z } from "zod";
import { isoDate, kobo } from "../../lib/schemas";
import { ACCOUNT_CODES } from "./ledger.service";

export const postEntrySchema = z.object({
  date: isoDate,
  description: z.string().min(1),
  reference: z.string().optional(),
  lines: z
    .array(
      z.object({
        account: z.enum(ACCOUNT_CODES),
        side: z.enum(["D", "C"]),
        amount: kobo,
      }),
    )
    .min(2),
});
export type PostEntryBody = z.infer<typeof postEntrySchema>;

export const reverseEntrySchema = z.object({
  date: isoDate.optional(),
  reason: z.string().optional(),
});
export type ReverseEntryBody = z.infer<typeof reverseEntrySchema>;

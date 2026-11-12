import { isUniqueViolation, db } from "../../database/db";
import { AppError } from "../../lib/errors";

export async function closePeriod(period: string) {
  try {
    return await db.$transaction(async (tx) => {
      // Wait for in-flight postings to commit; later inserts then hit the period trigger.
      await tx.$executeRaw`LOCK TABLE journal_entries IN SHARE ROW EXCLUSIVE MODE`;
      return tx.period.create({ data: { period } });
    });
  } catch (e) {
    if (isUniqueViolation(e))
      throw new AppError(
        `Period ${period} is already closed`,
        409,
        "PERIOD_ALREADY_CLOSED",
      );
    throw e;
  }
}

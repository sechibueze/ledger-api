import { Router } from "express";
import { db } from "../../database/db";
import { AppError } from "../../lib/errors";
import { uuid } from "../../lib/schemas";
import { postEntrySchema, reverseEntrySchema } from "./ledger.schemas";
import {
  getEntry,
  postEntry,
  reverseEntry,
  trialBalance,
} from "./ledger.service";
import { reversePayment } from "../payments/payment.service";

export const ledgerRouter = Router();

ledgerRouter.post("/entries", async (req, res) => {
  const body = postEntrySchema.parse(req.body);
  const entry = await db.$transaction((tx) =>
    postEntry(tx, {
      date: body.date,
      description: body.description,
      reference: body.reference,
      kind: "MANUAL",
      lines: body.lines.map((l) => ({
        account: l.account,
        side: l.side,
        amount: BigInt(l.amount),
      })),
    }),
  );
  res.status(201).json({
    success: true,
    data: await getEntry(entry.id),
  });
});

ledgerRouter.get("/entries/:id", async (req, res) => {
  res.json({
    success: true,
    data: await getEntry(uuid.parse(req.params.id)),
  });
});

ledgerRouter.post("/entries/:id/reverse", async (req, res) => {
  const id = uuid.parse(req.params.id);
  const body = reverseEntrySchema.parse(req.body ?? {});
  const original = await db.journalEntry.findUnique({ where: { id } });
  if (!original)
    throw new AppError("Journal entry not found", 404, "ENTRY_NOT_FOUND");

  // Payment entries must go through the payment engine so loan-level allocations stay in sync.
  if (original.paymentId) {
    if (original.kind !== "PAYMENT" || !original.loanId) {
      throw new AppError(
        "Reverse the payment instead of a correcting entry",
        409,
        "MANAGED_BY_PAYMENT_ENGINE",
      );
    }

    const reversedPayment = await reversePayment(
      original.loanId,
      original.paymentId,
      {
        reason: body.reason ?? "Ledger entry reversal",
        date: body.date,
      },
    );
    return res.status(201).json({ data: original });
  }
  const reversal = await reverseEntry(id, body);
  res.status(201).json({
    data: await getEntry(reversal.id),
  });
});

ledgerRouter.get("/trial-balance", async (_req, res) => {
  res.json({
    success: true,
    data: await trialBalance(),
  });
});

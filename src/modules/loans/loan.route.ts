import { Router } from "express";
import { uuid } from "../../lib/schemas";
import { createLoanSchema } from "./loan.schemas";
import { createLoan, getLoanView } from "./loan.service";
import { paymentRouter } from "../payments/payment.route";
import { db } from "../../database/db";

export const loanRouter = Router();

loanRouter.get("/:id/audit", async (req, res) => {
  const loanId = uuid.parse(req.params.id);
  const rows = await db.allocationAudit.findMany({
    where: { loanId },
    orderBy: { createdAt: "asc" },
  });
  res.json({
    data: rows.map((r) => ({
      at: r.createdAt,
      paymentId: r.paymentId,
      triggeredBy: r.triggerPaymentId,
      trigger: r.trigger,
      reason: r.reason,
      before: r.before,
      after: r.after,
      journalEntryId: r.journalEntryId,
    })),
  });
});

loanRouter.post("/", async (req, res) => {
  res
    .status(201)
    .json({ data: await createLoan(createLoanSchema.parse(req.body)) });
});

loanRouter.get("/:id", async (req, res) => {
  res.json({
    data: await getLoanView(uuid.parse(req.params.id)),
  });
});

loanRouter.use("/:id/payments", paymentRouter);

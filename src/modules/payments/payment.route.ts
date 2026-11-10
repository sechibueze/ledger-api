import { Router } from "express";
import { AppError } from "../../lib/errors";
import { uuid } from "../../lib/schemas";
import { createPaymentSchema } from "./payment.schemas";
import { reversePaymentSchema } from "./payment.schemas";
import { reversePayment } from "./payment.service";
import { createPayment } from "./payment.service";

export const paymentRouter = Router({ mergeParams: true });

paymentRouter.post("/:paymentId/reverse", async (req, res) => {
  const { id } = req.params as { id: string; paymentId: string };

  const loanId = uuid.parse(id);
  const paymentId = uuid.parse(req.params.paymentId);
  const body = reversePaymentSchema.parse(req.body ?? {});
  res.status(201).json({ data: await reversePayment(loanId, paymentId, body) });
});

paymentRouter.post("/", async (req, res) => {
  const { id } = req.params as { id: string };
  const loanId = uuid.parse(id);
  const key = req.header("Idempotency-Key");
  if (!key || key.length > 200)
    throw new AppError(
      "Idempotency-Key header is required",
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
    );
  const body = createPaymentSchema.parse(req.body);

  const result = await createPayment(loanId, key, body);
  if (result.replay) res.setHeader("Idempotent-Replay", "true");
  res.status(result.status).json({
    data: result.body,
  });
});

import { createHash } from "node:crypto";
import { isUniqueViolation, db, Tx } from "../../database/db";
import { fmt as formatDate, toDate, today } from "../../lib/date";
import { AppError } from "../../lib/errors";
import { accrueLoanTx } from "../jobs/accrual.service";
import { lockLoan } from "../loans/loan.service";
import type {
  CreatePaymentInput,
  ReversePaymentInput,
} from "./payment.schemas";
import { reallocate } from "./reallocation.service";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const plain = <T>(v: T): T =>
  JSON.parse(
    JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? Number(x) : x)),
  );

async function paymentView(tx: Tx, id: string) {
  const p = await tx.payment.findUniqueOrThrow({
    where: { id },
    include: { allocations: { include: { instalment: true } } },
  });
  return {
    id: p.id,
    loanId: p.loanId,
    seq: p.seq,
    amount: p.amount,
    paymentDate: formatDate(p.paymentDate),
    externalRef: p.externalRef,
    status: p.status,
    unapplied: p.unapplied,
    journalEntryId: p.journalEntryId,
    allocations: p.allocations
      .sort((a, b) => a.instalment.number - b.instalment.number)
      .map((a) => ({
        instalmentNumber: a.instalment.number,
        penalty: a.penalty,
        fee: a.fee,
        interest: a.interest,
        principal: a.principal,
      })),
  };
}

export async function createPayment(
  loanId: string,
  idemKey: string,
  input: CreatePaymentInput,
) {
  const normalised = { ...input, paymentDate: input.paymentDate ?? today() };
  const hash = sha(JSON.stringify({ loanId, ...normalised }));

  try {
    return await db.$transaction(async (tx) => {
      // The unique index on the keys blocks concurrent requests
      // until the first one commits
      const inserted = await tx.$queryRaw<{ key: string }[]>`
        INSERT INTO idempotency_keys (key, request_hash) VALUES (${idemKey}, ${hash})
        ON CONFLICT (key) DO NOTHING RETURNING key`;
      if (inserted.length === 0) {
        const existing = await tx.idempotencyKey.findUniqueOrThrow({
          where: { key: idemKey },
        });
        if (existing.requestHash !== hash) {
          throw new AppError(
            "Idempotency-Key was already used with a different request",
            422,
            "IDEMPOTENCY_KEY_REUSED",
          );
        }
        return {
          status: existing.responseStatus ?? 200,
          body: existing.responseBody,
          replay: true,
        };
      }

      await lockLoan(tx, loanId);
      // interest due by the payment date must exist before it is paid
      await accrueLoanTx(tx, loanId, normalised.paymentDate);

      const last = await tx.payment.aggregate({
        where: { loanId },
        _max: { seq: true },
      });

      const payment = await tx.payment.create({
        data: {
          loanId,
          seq: (last._max.seq ?? 0) + 1,
          amount: BigInt(normalised.amount),
          paymentDate: toDate(normalised.paymentDate),
          externalRef: normalised.externalRef,
        },
      });
      const adjustments = await reallocate(tx, loanId, {
        triggerPaymentId: payment.id,
        kind: "CREATED",
        entryDate: today(),
        reason: `Payment ${payment.id} received (history re-ordered by payment date)`,
      });

      const body = plain({
        ...(await paymentView(tx, payment.id)),
        adjustedPayments: adjustments.filter((a) => a.kind !== "PAYMENT"),
      });
      await tx.idempotencyKey.update({
        where: { key: idemKey },
        data: { responseStatus: 201, responseBody: body as object },
      });
      return { status: 201, body, replay: false };
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new AppError(
        "A payment with this externalRef already exists for the loan",
        409,
        "DUPLICATE_EXTERNAL_REF",
      );
    }
    throw e;
  }
}

export async function reversePayment(
  loanId: string,
  paymentId: string,
  input: { reason: string; date?: string },
) {
  return db.$transaction(async (tx) => {
    await lockLoan(tx, loanId);
    const payment = await tx.payment.findFirst({
      where: { id: paymentId, loanId },
    });
    if (!payment)
      throw new AppError(
        "Payment not found on this loan",
        404,
        "PAYMENT_NOT_FOUND",
      );
    if (payment.status === "REVERSED")
      throw new AppError(
        "Payment has already been reversed",
        409,
        "ALREADY_REVERSED",
      );

    await tx.payment.update({
      where: { id: paymentId },
      data: {
        status: "REVERSED",
        reversedAt: new Date(),
        reverseReason: input.reason,
      },
    });
    const adjustments = await reallocate(tx, loanId, {
      triggerPaymentId: paymentId,
      kind: "REVERSED",
      entryDate: input.date ?? today(),
      reason: `Payment ${paymentId} reversed: ${input.reason}`,
    });
    return plain({ payment: await paymentView(tx, paymentId), adjustments });
  });
}

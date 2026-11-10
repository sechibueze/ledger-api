import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";

export class AppError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

const DB_ERRORS: Record<string, number> = {
  ENTRY_UNBALANCED: 422,
  ENTRY_TOO_FEW_LINES: 422,
  PERIOD_CLOSED: 422,
  LEDGER_IMMUTABLE: 409,
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError)
    return res
      .status(400)
      .json({ error: "VALIDATION_ERROR", details: err.issues });
  if (err instanceof AppError)
    return res
      .status(err.status)
      .json({ error: err.code, message: err.message, details: err.details });
  if (err?.type === "entity.parse.failed")
    return res.status(400).json({ error: "INVALID_JSON" });
  const msg = String(err?.message ?? "");
  for (const [code, status] of Object.entries(DB_ERRORS)) {
    if (msg.includes(code))
      return res.status(status).json({ error: code, message: msg });
  }
  console.error(err);
  res.status(500).json({ error: "INTERNAL_ERROR" });
};

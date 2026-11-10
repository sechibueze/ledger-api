import express from "express";
import { errorHandler } from "./lib/errors";
import { invoiceRouter } from "./modules/invoices/invoice.route";
import { ledgerRouter } from "./modules/ledger/ledger.route";
import { loanRouter } from "./modules/loans/loan.route";
import { jobRouter } from "./modules/jobs/job.route";

export const app = express();
app.use(express.json());
app.set("json replacer", (_k: string, v: unknown) =>
  typeof v === "bigint" ? Number(v) : v,
);

app.use("/ledger", ledgerRouter);
app.use("/invoices", invoiceRouter);
app.use("/loans", loanRouter);
app.use("/jobs", jobRouter);
app.use(errorHandler);

import express from "express";
import { errorHandler } from "./lib/errors";
import { invoiceRouter } from "./modules/invoices/invoice.route";

export const app = express();
app.use(express.json());
app.set("json replacer", (_k: string, v: unknown) =>
  typeof v === "bigint" ? Number(v) : v,
);

app.use("/invoices", invoiceRouter);

app.use(errorHandler);

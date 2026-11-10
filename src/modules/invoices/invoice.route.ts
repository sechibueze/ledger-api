import { Router } from "express";
import { quoteInvoice, quoteInvoiceSchema } from "./invoice.service";

export const invoiceRouter = Router();

invoiceRouter.post("/quote", (req, res) => {
  res.json(quoteInvoice(quoteInvoiceSchema.parse(req.body)));
});

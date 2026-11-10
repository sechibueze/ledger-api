import { Router } from "express";
import { uuid } from "../../lib/schemas";
import { createLoanSchema } from "./loan.schemas";
import { createLoan, getLoanView } from "./loan.service";

export const loanRouter = Router();

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

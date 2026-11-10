import { Router } from "express";
import { z } from "zod";
import { isoDate } from "../../lib/schemas";
import { runAccrual } from "./accrual.service";

export const jobRouter = Router();

jobRouter.post("/accrue", async (req, res) => {
  const { asOfDate } = z.object({ asOfDate: isoDate }).parse(req.query);
  const result = await runAccrual(asOfDate as string);
  res.json({
    data: result,
  });
});

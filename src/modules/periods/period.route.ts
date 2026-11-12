import { Router } from "express";
import { z } from "zod";
import { closePeriod } from "./period.service";

export const periodRouter = Router();
const periodParam = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Expected YYYY-MM");

periodRouter.post("/:period/close", async (req, res) => {
  const row = await closePeriod(periodParam.parse(req.params.period));
  res.status(201).json({ period: row.period, closedAt: row.closedAt });
});

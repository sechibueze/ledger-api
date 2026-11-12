import { Router } from "express";
import { reconcile } from "./reconciliation.service";

export const reconciliationRouter = Router();

reconciliationRouter.get("/", async (_req, res) => {
  res.json({ data: await reconcile() });
});

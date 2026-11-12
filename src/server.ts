import "dotenv/config";
import { app } from "./app";
import { startAccrualScheduler } from "./modules/jobs/accrual.scheduler";

const port = Number(process.env.PORT ?? 4010);
app.listen(port, () => console.log(`ledger listening on :${port}`));
if (process.env.REDIS_URL)
  startAccrualScheduler(process.env.REDIS_URL).catch(console.error);

import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { today } from "../../lib/date";
import { runAccrual } from "./accrual.service";

export async function startAccrualScheduler(redisUrl: string) {
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue("accrual", { connection });
  await queue.upsertJobScheduler(
    "nightly-accrual",
    { pattern: "5 0 * * *" },
    { name: "accrue" },
  );
  new Worker("accrual", async () => runAccrual(today()), { connection });
}

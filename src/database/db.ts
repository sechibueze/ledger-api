import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "./generated/prisma/client";

export const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.DATABASE_URL!,
    max: 20,
  }),
  transactionOptions: { maxWait: 30_000, timeout: 60_000 },
});

export type Tx = Prisma.TransactionClient;
export const isUniqueViolation = (e: unknown) =>
  (e as { code?: string })?.code === "P2002";

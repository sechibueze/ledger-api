import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "src/database/schema.prisma",
  migrations: {
    path: "src/database/migrations",
    seed: "tsx src/database/seeds/index.ts",
  },
  datasource: {
    url: process.env.DATABASE_URL!,
  },
});

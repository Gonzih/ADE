import type { Config } from "drizzle-kit";

export default {
  schema: "./src/main/db/schema.ts",
  out: "./src/main/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost/ade",
  },
} satisfies Config;

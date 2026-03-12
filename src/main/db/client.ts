import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

let _pool: Pool | null = null;
let _db: ReturnType<typeof drizzle> | null = null;

export function getDb() {
  if (!_db) throw new Error("DB not initialized. Call initDb() first.");
  return _db;
}

export async function initDb(databaseUrl?: string): Promise<void> {
  const url = databaseUrl || process.env.DATABASE_URL || "postgres://localhost/ade";
  _pool = new Pool({ connectionString: url });
  // Verify connection
  await _pool.query("SELECT 1");
  _db = drizzle(_pool, { schema });
}

export async function closeDb(): Promise<void> {
  if (_pool) await _pool.end();
}

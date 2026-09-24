import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

/**
 * OPTIONAL PostgreSQL client (template tooling only).
 *
 * BharatTube's frontend does NOT use PostgreSQL: every page and API route
 * reads and writes through the existing deployed backend
 * (https://bharattube-ylmq.onrender.com/api/v1), which uses the existing
 * MongoDB. No route handler imports this module.
 *
 * IMPORTANT — Vercel build safety:
 * This file must never throw while being imported. Doing the DATABASE_URL
 * check at module scope previously broke `next build` with
 *   "DATABASE_URL is required / Failed to collect page data for /api/channel"
 * because Next.js evaluates route modules (and their import graph) at build
 * time, where no database is configured. The connection is therefore created
 * lazily: it is only attempted if something explicitly uses `getDb()`, and a
 * missing DATABASE_URL is reported at that call, not at import.
 */

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
};

let cachedDb: ReturnType<typeof drizzle> | null = null;

/** True when a PostgreSQL connection string is configured. */
export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/** Lazily creates the pool. Throws only when actually called without config. */
export function getPool(): Pool {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not configured. BharatTube uses the external backend API (NEXT_PUBLIC_API_URL) and does not require PostgreSQL."
    );
  }

  const pool =
    globalForDb.__arenaNextJsPostgresqlPool ??
    new Pool({ connectionString: databaseUrl });

  if (process.env.NODE_ENV !== "production") {
    globalForDb.__arenaNextJsPostgresqlPool = pool;
  }
  return pool;
}

/** Lazily creates the Drizzle client. Not used by any BharatTube route. */
export function getDb() {
  if (!cachedDb) {
    cachedDb = drizzle(getPool());
  }
  return cachedDb;
}

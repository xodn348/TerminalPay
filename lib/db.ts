import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const dir = join(homedir(), ".agentwallet");
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

const dbPath = join(dir, "db.sqlite");

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    stripe_customer_id TEXT,
    stripe_pm_id TEXT,
    card_last4 TEXT,
    card_brand TEXT,
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    api_key_hash TEXT NOT NULL,
    monthly_limit_cents INTEGER NOT NULL,
    per_tx_limit_cents INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    amount_cents INTEGER NOT NULL,
    merchant TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL,
    stripe_pi_id TEXT,
    idempotency_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (agent_id, idempotency_key)
  );

  CREATE INDEX IF NOT EXISTS idx_payments_agent_created
    ON payments(agent_id, created_at);
`;

declare global {
  // Prevents multiple instances across Next.js HMR reloads in dev.
  // eslint-disable-next-line no-var
  var __agentwallet_db: DatabaseSync | undefined;
}

function createDb(): DatabaseSync {
  const instance = new DatabaseSync(dbPath);
  instance.exec("PRAGMA journal_mode = WAL");
  instance.exec("PRAGMA foreign_keys = ON");
  instance.exec(SCHEMA);
  globalThis.__agentwallet_db = instance;
  return instance;
}

export const db: DatabaseSync = globalThis.__agentwallet_db ?? createDb();

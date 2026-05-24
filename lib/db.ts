import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

function resolveDbPath(): string {
  const override = process.env["TERMPAY_DB_PATH"];
  if (override) return override;
  const dir = join(homedir(), ".termpay");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, "db.sqlite");
}

const dbPath = resolveDbPath();

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    encrypted_card BLOB,
    card_last4 TEXT,
    card_brand TEXT,
    card_exp TEXT,
    vault_key_id TEXT,
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
    merchant_url TEXT,
    reason TEXT NOT NULL,
    status TEXT NOT NULL,  -- 'pending' | 'succeeded' | 'failed' | 'denied' | 'unknown'
    evidence TEXT,
    idempotency_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (agent_id, idempotency_key)
  );

  CREATE INDEX IF NOT EXISTS idx_payments_agent_created
    ON payments(agent_id, created_at);

  CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    agent_id TEXT,
    payment_id TEXT,
    payload_json TEXT
  );
`;

function createDb(): DatabaseSync {
  const instance = new DatabaseSync(dbPath);
  instance.exec("PRAGMA journal_mode = WAL");
  instance.exec("PRAGMA foreign_keys = ON");
  instance.exec(SCHEMA);
  return instance;
}

export const db: DatabaseSync = createDb();

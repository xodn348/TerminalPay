import { randomUUID } from "node:crypto";
import { db } from "./db.ts";
import type { Purchase, PurchaseStatus } from "./types.ts";

export interface CreatePurchaseInput {
  agent_id: string;
  agent_name: string | null;
  intent: string;
  merchant: string;
  max_amount_cents: number;
  reason: string;
  idempotency_key: string;
  driver: string;
}

export interface CreatePurchaseResult {
  purchase: Purchase;
  created: boolean; // false when an existing row was returned (idempotent replay)
}

export function createPurchase(input: CreatePurchaseInput): CreatePurchaseResult {
  const existing = db
    .prepare("SELECT * FROM purchases WHERE agent_id = ? AND idempotency_key = ?")
    .get(input.agent_id, input.idempotency_key) as unknown as Purchase | undefined;
  if (existing) return { purchase: existing, created: false };

  const id = randomUUID();
  const startedAt = Date.now();
  db.prepare(
    `INSERT INTO purchases
       (id, agent_id, agent_name, status, intent, merchant, max_amount_cents,
        reason, idempotency_key, payment_id, order_id, evidence, progress,
        last_screenshot_path, error, driver, started_at, finished_at)
     VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL,
             NULL, NULL, ?, ?, NULL)`,
  ).run(
    id, input.agent_id, input.agent_name, input.intent, input.merchant,
    input.max_amount_cents, input.reason, input.idempotency_key,
    input.driver, startedAt,
  );

  const row = db
    .prepare("SELECT * FROM purchases WHERE id = ?")
    .get(id) as unknown as Purchase;
  return { purchase: row, created: true };
}

export function getPurchase(id: string): Purchase | undefined {
  return db
    .prepare("SELECT * FROM purchases WHERE id = ?")
    .get(id) as unknown as Purchase | undefined;
}

export function getPurchaseForAgent(id: string, agent_id: string): Purchase | undefined {
  return db
    .prepare("SELECT * FROM purchases WHERE id = ? AND agent_id = ?")
    .get(id, agent_id) as unknown as Purchase | undefined;
}

export function listPurchasesForAgent(agent_id: string, limit: number): Purchase[] {
  return db
    .prepare(
      "SELECT * FROM purchases WHERE agent_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?",
    )
    .all(agent_id, limit) as unknown as Purchase[];
}

export interface UpdatePurchaseInput {
  status?: PurchaseStatus;
  progress?: string | null;
  last_screenshot_path?: string | null;
  payment_id?: string | null;
  order_id?: string | null;
  evidence?: string | null;
  error?: string | null;
  finished_at?: number | null;
}

type SqlValue = string | number | bigint | Uint8Array | null;

export function updatePurchase(id: string, patch: UpdatePurchaseInput): Purchase | undefined {
  const fields: string[] = [];
  const values: SqlValue[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    fields.push(`${k} = ?`);
    values.push(v as SqlValue);
  }
  if (fields.length === 0) return getPurchase(id);
  values.push(id);
  db.prepare(`UPDATE purchases SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getPurchase(id);
}

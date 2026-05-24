import { randomUUID } from "node:crypto";
import { db } from "./db.ts";
import { evaluate } from "./policy.ts";
import { LocalCardSource } from "./card_source.ts";
import type { Agent, Payment } from "./types.ts";

export interface PayInput {
  agent: Agent;
  amount_cents: number;
  merchant: string;
  merchant_url: string | undefined;
  reason: string;
  idempotency_key: string;
  cvv: string; // passed to chargeCard in Phase 3; must be non-empty
}

export type PayResult =
  | { ok: true; payment: Payment }
  | { ok: false; error: string };

export async function runPay(input: PayInput): Promise<PayResult> {
  // Return original row unchanged on duplicate (agent_id, idempotency_key)
  const existing = db
    .prepare("SELECT * FROM payments WHERE agent_id = ? AND idempotency_key = ?")
    .get(input.agent.id, input.idempotency_key) as unknown as Payment | undefined;
  if (existing) return { ok: true, payment: existing };

  // Policy: compute monthly spend for this agent in the current UTC month
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const spentRow = db
    .prepare(
      "SELECT COALESCE(SUM(amount_cents), 0) as total FROM payments " +
        "WHERE agent_id = ? AND status = 'succeeded' AND created_at >= ?",
    )
    .get(input.agent.id, monthStart) as unknown as { total: number };

  const decision = evaluate({
    agent: input.agent,
    amount_cents: input.amount_cents,
    monthly_spent_cents: spentRow.total,
  });
  if (decision.outcome === "deny") {
    return { ok: false, error: decision.reasons[0] ?? "denied" };
  }

  // Decrypt card to verify vault access before inserting the pending row
  const source = new LocalCardSource();
  await source.ensureCard(); // throws if no card stored or vault key wrong

  // Record as pending before any charge attempt
  const id = randomUUID();
  const createdAt = Date.now();
  db.prepare(
    `INSERT INTO payments
       (id, agent_id, amount_cents, merchant, merchant_url, reason,
        status, evidence, idempotency_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`,
  ).run(
    id, input.agent.id, input.amount_cents, input.merchant,
    input.merchant_url ?? null, input.reason, input.idempotency_key, createdAt,
  );

  // Stub checkout — Phase 3 replaces with lib/checkout.ts chargeCard()
  const status: Payment["status"] = "succeeded";
  const evidence = "STUB";

  db.prepare("UPDATE payments SET status = ?, evidence = ? WHERE id = ?")
    .run(status, evidence, id);

  const payment = db
    .prepare("SELECT * FROM payments WHERE id = ?")
    .get(id) as unknown as Payment;

  return { ok: true, payment };
}

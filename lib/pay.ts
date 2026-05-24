import { randomUUID } from "node:crypto";
import { db } from "./db.ts";
import { evaluate } from "./policy.ts";
import { LocalCardSource } from "./card_source.ts";
import { chargeCard } from "./checkout.ts";
import { CHECKOUT_URL } from "./merchants/anthropic.ts";
import type { Agent, Payment } from "./types.ts";

// Default checkout URLs by merchant hostname
const DEFAULT_CHECKOUT_URLS: Record<string, string> = {
  "console.anthropic.com": CHECKOUT_URL,
};

export interface PayInput {
  agent: Agent;
  agent_name?: string; // MCP clientInfo.name or CLI caller label; stored on the payment row
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

  // Allowed-merchants check (settings.allowed_merchants JSON array; null = allow all)
  const settingsRow = db
    .prepare("SELECT allowed_merchants FROM settings WHERE id = 1")
    .get() as unknown as { allowed_merchants: string | null } | undefined;
  if (settingsRow?.allowed_merchants) {
    const allowed = JSON.parse(settingsRow.allowed_merchants) as string[];
    if (!allowed.includes("*") && !allowed.includes(input.merchant)) {
      return { ok: false, error: "merchant_not_allowed" };
    }
  }

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
       (id, agent_id, agent_name, amount_cents, merchant, merchant_url, reason,
        status, evidence, idempotency_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`,
  ).run(
    id, input.agent.id, input.agent_name ?? null, input.amount_cents, input.merchant,
    input.merchant_url ?? null, input.reason, input.idempotency_key, createdAt,
  );

  // Resolve checkout URL
  const checkoutUrl =
    input.merchant_url ??
    DEFAULT_CHECKOUT_URLS[input.merchant] ??
    `https://${input.merchant}`;

  // Set CVV in env for chargeCard; restore/wipe after charge (G5)
  const prevCvv = process.env["TERMPAY_CARD_CVV"];
  process.env["TERMPAY_CARD_CVV"] = input.cvv;

  const controller = new AbortController();
  // 29 s hard timeout so pay process lifetime stays ≤ 30 s (G5)
  const timer = setTimeout(() => controller.abort(), 29_000);

  let chargeStatus: Payment["status"] = "unknown";
  let chargeEvidence: string | null = null;

  try {
    const outcome = await chargeCard(
      await source.ensureCard(),
      checkoutUrl,
      input.amount_cents,
      controller.signal,
    );
    chargeStatus =
      outcome.status === "succeeded" ? "succeeded" :
      outcome.status === "failed"    ? "failed" :
      "unknown"; // requires_human → unknown until Phase 4 3DS TUI
    chargeEvidence = outcome.evidence;
  } catch (err) {
    chargeStatus = "unknown";
    chargeEvidence = err instanceof Error ? err.message.slice(0, 200) : "error";
  } finally {
    clearTimeout(timer);
    // Wipe CVV from env (G5: no CVV in process state after pay exits)
    if (prevCvv !== undefined) {
      process.env["TERMPAY_CARD_CVV"] = prevCvv;
    } else {
      delete process.env["TERMPAY_CARD_CVV"];
    }
  }

  db.prepare("UPDATE payments SET status = ?, evidence = ? WHERE id = ?")
    .run(chargeStatus, chargeEvidence, id);

  const payment = db
    .prepare("SELECT * FROM payments WHERE id = ?")
    .get(id) as unknown as Payment;

  return { ok: true, payment };
}

import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import Stripe from "stripe";
import { db } from "@/lib/db";
import { getStripe } from "@/lib/stripe";
import { getAgentByApiKey } from "@/lib/agent-keys";
import { evaluate } from "@/lib/policy";
import type { Agent, Payment, Settings } from "@/lib/types";

/**
 * Request body accepted by `POST /api/pay`.
 *
 * - `amount_cents`: integer >= 1; denominated in USD cents.
 * - `merchant`: trimmed, 1..200 chars.
 * - `reason`: trimmed, 1..1000 chars. Required for audit + UX in the dashboard.
 * - `idempotency_key`: 8..128 chars; used to dedupe agent retries and as the
 *   Stripe `idempotencyKey` for PaymentIntent creation.
 */
const paySchema = z.object({
  amount_cents: z.number().int().min(1),
  merchant: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(1000),
  idempotency_key: z.string().min(8).max(128),
});

type PayBody = z.infer<typeof paySchema>;

/**
 * Result of looking up an existing payment by `(agent_id, idempotency_key)`.
 * The dashboard projection of `Payment` is what we return to the caller — the
 * `idempotency_key` itself is not echoed back.
 */
type PaymentPublic = Omit<Payment, "idempotency_key">;

const PAYMENT_PUBLIC_COLUMNS =
  "id, agent_id, amount_cents, merchant, reason, status, stripe_pi_id, created_at";

/**
 * Start-of-current-month timestamp in UTC, as ms since epoch.
 *
 * Used to scope the monthly spend rollup to the current calendar month
 * (UTC) when evaluating policy rule #4.
 */
function startOfCurrentMonthUtc(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

/**
 * Pull the Bearer token from an `Authorization` header. Returns `null` for any
 * shape we cannot confidently parse so the caller can answer 401 uniformly.
 */
function extractBearer(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(ak_[0-9a-f]+)$/.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * Look up a previous payment for `(agent_id, idempotency_key)`. When present,
 * the caller short-circuits and returns the prior result unchanged.
 */
function findExistingPayment(
  agentId: string,
  idempotencyKey: string,
): PaymentPublic | null {
  const row = db
    .prepare(
      `SELECT ${PAYMENT_PUBLIC_COLUMNS}
         FROM payments
        WHERE agent_id = ? AND idempotency_key = ?`,
    )
    .get(agentId, idempotencyKey) as PaymentPublic | undefined;
  return row ?? null;
}

/**
 * Sum of `amount_cents` over `succeeded` payments for `agentId` in the current
 * UTC month. Failed and denied attempts do not count toward the cap.
 */
function getMonthlySpentCents(agentId: string): number {
  const monthStart = startOfCurrentMonthUtc();
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total
         FROM payments
        WHERE agent_id = ?
          AND status = 'succeeded'
          AND created_at >= ?`,
    )
    .get(agentId, monthStart) as { total: number | bigint };
  return Number(row.total);
}

/**
 * Insert a payment row and return its public projection. `created_at` is
 * captured at insert time so it matches the persisted row exactly.
 */
function insertPayment(args: {
  agent_id: string;
  amount_cents: number;
  merchant: string;
  reason: string;
  status: Payment["status"];
  stripe_pi_id: string | null;
  idempotency_key: string;
}): PaymentPublic {
  const id = randomUUID();
  const created_at = Date.now();
  db.prepare(
    `INSERT INTO payments
       (id, agent_id, amount_cents, merchant, reason, status, stripe_pi_id, idempotency_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    args.agent_id,
    args.amount_cents,
    args.merchant,
    args.reason,
    args.status,
    args.stripe_pi_id,
    args.idempotency_key,
    created_at,
  );
  return {
    id,
    agent_id: args.agent_id,
    amount_cents: args.amount_cents,
    merchant: args.merchant,
    reason: args.reason,
    status: args.status,
    stripe_pi_id: args.stripe_pi_id,
    created_at,
  };
}

/**
 * Map a stored payment to the JSON shape we return on the synchronous response.
 * The wire shape mirrors what `GET /api/payments` produces for dashboard reuse.
 */
function replayResponse(prior: PaymentPublic): NextResponse {
  if (prior.status === "succeeded") {
    return NextResponse.json({ status: "succeeded", payment: prior });
  }
  if (prior.status === "denied") {
    // We do not persist the structured policy reasons separately; the dashboard
    // can re-derive them. For replay, return a single replayed-denial marker so
    // the response shape matches the original.
    return NextResponse.json({
      status: "denied",
      reasons: ["replayed_denied"],
    });
  }
  // status === "failed"
  return NextResponse.json({
    status: "failed",
    error_code: "replayed_failed",
    error_message: "previous attempt failed",
  });
}

/**
 * `POST /api/pay` — the payment engine entry point.
 *
 * Auth: `Authorization: Bearer ak_<hex>`. Body: see {@link paySchema}.
 *
 * Flow:
 *   1. Authenticate via raw key → agent.
 *   2. Validate body.
 *   3. Idempotency replay if `(agent, idempotency_key)` already exists.
 *   4. Require card setup (settings row with customer + payment method).
 *   5. Aggregate monthly spend, evaluate policy.
 *   6. On approve, create a Stripe off-session PaymentIntent and persist outcome.
 */
export async function POST(req: Request): Promise<NextResponse> {
  // 1. Authentication
  const rawKey = extractBearer(req.headers.get("authorization"));
  if (!rawKey) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const agent: Agent | null = getAgentByApiKey(rawKey);
  if (!agent) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // 2. Body validation
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = paySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const input: PayBody = parsed.data;

  // 3. Idempotency replay
  const prior = findExistingPayment(agent.id, input.idempotency_key);
  if (prior) {
    return replayResponse(prior);
  }

  // 4. Card setup check
  const settings = db
    .prepare(
      `SELECT id, stripe_customer_id, stripe_pm_id, card_last4, card_brand, created_at
         FROM settings
        WHERE id = 1`,
    )
    .get() as Settings | undefined;

  if (!settings || !settings.stripe_customer_id || !settings.stripe_pm_id) {
    // Persist audit row so the dashboard reflects the rejected attempt.
    try {
      insertPayment({
        agent_id: agent.id,
        amount_cents: input.amount_cents,
        merchant: input.merchant,
        reason: input.reason,
        status: "denied",
        stripe_pi_id: null,
        idempotency_key: input.idempotency_key,
      });
    } catch (err) {
      // Best-effort audit; do not mask the user-visible error.
      console.error("audit insert failed (card_not_set_up)", err);
    }
    return NextResponse.json(
      { error: "card_not_set_up" },
      { status: 400 },
    );
  }

  // 5. Policy evaluation
  const monthly_spent_cents = getMonthlySpentCents(agent.id);
  const decision = evaluate({
    agent,
    amount_cents: input.amount_cents,
    monthly_spent_cents,
  });

  if (decision.outcome === "deny") {
    try {
      insertPayment({
        agent_id: agent.id,
        amount_cents: input.amount_cents,
        merchant: input.merchant,
        reason: input.reason,
        status: "denied",
        stripe_pi_id: null,
        idempotency_key: input.idempotency_key,
      });
    } catch (err) {
      // If the unique constraint trips, a concurrent retry won the race —
      // replay the stored result rather than confuse the caller.
      console.error("denied insert failed", err);
      const replay = findExistingPayment(agent.id, input.idempotency_key);
      if (replay) return replayResponse(replay);
    }
    return NextResponse.json({ status: "denied", reasons: decision.reasons });
  }

  // 6. Charge via Stripe (off-session, immediate confirm)
  const stripe = getStripe();
  try {
    const pi = await stripe.paymentIntents.create(
      {
        amount: input.amount_cents,
        currency: "usd",
        customer: settings.stripe_customer_id,
        payment_method: settings.stripe_pm_id,
        off_session: true,
        confirm: true,
      },
      { idempotencyKey: input.idempotency_key },
    );

    const succeeded = pi.status === "succeeded";
    const payment = insertPayment({
      agent_id: agent.id,
      amount_cents: input.amount_cents,
      merchant: input.merchant,
      reason: input.reason,
      status: succeeded ? "succeeded" : "failed",
      stripe_pi_id: pi.id,
      idempotency_key: input.idempotency_key,
    });

    if (succeeded) {
      return NextResponse.json({ status: "succeeded", payment });
    }
    return NextResponse.json({
      status: "failed",
      error_code: pi.status,
      error_message: `payment_intent_status_${pi.status}`,
    });
  } catch (err) {
    // Stripe surfaces card decline / authentication_required as errors with
    // a `code` and (sometimes) an attached PaymentIntent. Persist a failed
    // attempt so the dashboard sees it; respond 200 because policy + auth
    // succeeded — the *charge* failed.
    const stripeErr = err as Stripe.errors.StripeError;
    const error_code = stripeErr?.code ?? "stripe_error";
    const error_message = stripeErr?.message ?? "stripe_error";

    try {
      insertPayment({
        agent_id: agent.id,
        amount_cents: input.amount_cents,
        merchant: input.merchant,
        reason: input.reason,
        status: "failed",
        stripe_pi_id: null,
        idempotency_key: input.idempotency_key,
      });
    } catch (insertErr) {
      console.error("failed insert failed", insertErr);
      const replay = findExistingPayment(agent.id, input.idempotency_key);
      if (replay) return replayResponse(replay);
    }

    return NextResponse.json({
      status: "failed",
      error_code,
      error_message,
    });
  }
}

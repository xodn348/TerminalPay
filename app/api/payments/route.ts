import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import type { Payment } from "@/lib/types";

/**
 * Public projection of {@link Payment} returned to the dashboard. The
 * `idempotency_key` is intentionally omitted — it is an internal dedup token,
 * not user-facing data.
 */
type PaymentPublic = Omit<Payment, "idempotency_key">;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const querySchema = z.object({
  agent_id: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
});

/**
 * `GET /api/payments` — dashboard-facing list of recent payments.
 *
 * Query params:
 *   - `agent_id` (optional): filter to a single agent.
 *   - `limit`    (optional): 1..200; defaults to 50.
 *
 * No authentication: this route is for the localhost owner dashboard only.
 * Returns `{ payments }` with newest rows first.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    agent_id: url.searchParams.get("agent_id") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const limit = parsed.data.limit ?? DEFAULT_LIMIT;
  const agentId = parsed.data.agent_id;

  try {
    const rows = agentId
      ? (db
          .prepare(
            `SELECT id, agent_id, amount_cents, merchant, reason, status, stripe_pi_id, created_at
               FROM payments
              WHERE agent_id = ?
              ORDER BY created_at DESC
              LIMIT ?`,
          )
          .all(agentId, limit) as PaymentPublic[])
      : (db
          .prepare(
            `SELECT id, agent_id, amount_cents, merchant, reason, status, stripe_pi_id, created_at
               FROM payments
              ORDER BY created_at DESC
              LIMIT ?`,
          )
          .all(limit) as PaymentPublic[]);

    return NextResponse.json({ payments: rows });
  } catch (err) {
    console.error("GET /api/payments failed", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

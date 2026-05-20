import type { PolicyDecision, PolicyInput } from "@/lib/types";

/**
 * Deny reason codes emitted by {@link evaluate}. Stable strings — clients and
 * audit logs depend on them.
 */
export type DenyReason =
  | "agent_killed"
  | "invalid_amount"
  | "per_tx_limit_exceeded"
  | "monthly_limit_exceeded";

/**
 * Approve reason code emitted by {@link evaluate} on the happy path.
 */
export type ApproveReason = "ok";

/**
 * Evaluate the agent payment policy for a single charge attempt.
 *
 * Pure, deterministic, and synchronous: no DB, no network, no clock. The
 * caller is responsible for loading `agent` and aggregating
 * `monthly_spent_cents` (sum of `succeeded` payments in the current UTC month
 * for this agent).
 *
 * Rules are evaluated in order and short-circuit on the first deny:
 *
 *   1. `agent.status !== "active"`                                 → `agent_killed`
 *   2. `amount_cents <= 0`                                         → `invalid_amount`
 *   3. `amount_cents > agent.per_tx_limit_cents`                   → `per_tx_limit_exceeded`
 *   4. `monthly_spent_cents + amount_cents > monthly_limit_cents`  → `monthly_limit_exceeded`
 *   5. otherwise                                                   → approve with `ok`
 *
 * For MVP-α `reasons` is always a single-element array; the array shape is
 * preserved so future rule composition does not change the type.
 *
 * @param input - `{ agent, amount_cents, monthly_spent_cents }`.
 * @returns A {@link PolicyDecision} with `outcome` and a `reasons` array.
 *
 * @example
 *   const decision = evaluate({ agent, amount_cents: 1200, monthly_spent_cents: 0 });
 *   if (decision.outcome === "deny") return denyResponse(decision.reasons);
 */
export function evaluate(input: PolicyInput): PolicyDecision {
  const { agent, amount_cents, monthly_spent_cents } = input;

  if (agent.status !== "active") {
    return { outcome: "deny", reasons: ["agent_killed"] };
  }
  if (amount_cents <= 0) {
    return { outcome: "deny", reasons: ["invalid_amount"] };
  }
  if (amount_cents > agent.per_tx_limit_cents) {
    return { outcome: "deny", reasons: ["per_tx_limit_exceeded"] };
  }
  if (monthly_spent_cents + amount_cents > agent.monthly_limit_cents) {
    return { outcome: "deny", reasons: ["monthly_limit_exceeded"] };
  }
  return { outcome: "approve", reasons: ["ok"] };
}

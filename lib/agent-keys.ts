import { createHash, randomBytes } from "node:crypto";
import { db } from "./db.ts";
import type { Agent } from "./types.ts";

/**
 * A freshly generated agent API key.
 *
 * `raw` is shown to the user exactly once and is what the agent presents as
 * a Bearer token. `hash` is the sha256 hex digest stored in `agents.api_key_hash`.
 */
export interface GeneratedApiKey {
  raw: string;
  hash: string;
}

/**
 * Compute the canonical storage form of an API key.
 *
 * The DB never holds the raw key; we only persist this hash and compare hashes
 * on lookup. Plain sha256 (no salt) is enough here because the raw key has
 * 128 bits of entropy from `randomBytes(16)` — brute-forcing the preimage is
 * infeasible and there is no slow-hash benefit to add.
 *
 * @param raw - Raw API key as returned by {@link generateApiKey}.
 * @returns sha256 hex digest of `raw`.
 *
 * @example
 *   const h = hashApiKey("ak_0123456789abcdef0123456789abcdef");
 */
export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Generate a new agent API key plus its storage hash.
 *
 * Format: `ak_` + 32 lowercase hex characters from 16 random bytes (128 bits
 * of entropy). The caller stores `hash` in the `agents` table and returns
 * `raw` to the user one time.
 *
 * @returns A `{ raw, hash }` pair. Never log `raw`.
 *
 * @example
 *   const { raw, hash } = generateApiKey();
 */
export function generateApiKey(): GeneratedApiKey {
  const raw = `ak_${randomBytes(16).toString("hex")}`;
  return { raw, hash: hashApiKey(raw) };
}

/**
 * Look up an agent by its raw API key.
 *
 * Hashes the supplied key and selects the matching row from `agents`. Used by
 * `POST /api/pay` (Phase 2) to authenticate the caller. Returns `null` when
 * no agent matches — callers must NOT distinguish "no such key" from
 * "wrong key" in responses.
 *
 * @param raw - Raw Bearer token supplied by the agent.
 * @returns The matching {@link Agent} row, or `null` if none.
 *
 * @example
 *   const agent = getAgentByApiKey(req.headers.get("authorization")?.slice(7) ?? "");
 *   if (!agent || agent.status !== "active") return new Response("forbidden", { status: 403 });
 */
export function getAgentByApiKey(raw: string): Agent | null {
  if (!raw) return null;
  const hash = hashApiKey(raw);
  const row = db
    .prepare(
      `SELECT id, name, api_key_hash, monthly_limit_cents, per_tx_limit_cents, status, created_at
         FROM agents
        WHERE api_key_hash = ?`,
    )
    .get(hash) as Agent | undefined;
  return row ?? null;
}

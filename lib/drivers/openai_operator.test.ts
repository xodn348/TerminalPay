import { test } from "node:test";
import assert from "node:assert";
import { randomUUID } from "node:crypto";

process.env["TERMPAY_DB_PATH"] =
  process.env["TERMPAY_DB_PATH"] ?? `/tmp/termpay-openai-test-${randomUUID()}.sqlite`;
process.env["TERMPAY_VAULT_KEY"] =
  process.env["TERMPAY_VAULT_KEY"] ??
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const { db } = await import("../db.ts");
const { createPurchase, getPurchase } = await import("../purchases.ts");
const { OpenaiOperatorDriver } = await import("./openai_operator.ts");

test("OpenaiOperatorDriver marks the purchase failed with not_implemented", () => {
  const agent_id = randomUUID();
  db.prepare(
    `INSERT INTO agents (id, name, api_key_hash, monthly_limit_cents, per_tx_limit_cents, status, created_at)
     VALUES (?, 't', 'h', 1000, 500, 'active', ?)`,
  ).run(agent_id, Date.now());

  const { purchase } = createPurchase({
    agent_id,
    agent_name: null,
    intent: "x",
    merchant: "amazon.com",
    max_amount_cents: 100,
    reason: "r",
    idempotency_key: `k-${randomUUID()}`,
    driver: "openai_operator",
  });

  new OpenaiOperatorDriver().run({
    purchase_id: purchase.id,
    agent_id,
    intent: "x",
    merchant: "amazon.com",
    max_amount_cents: 100,
    reason: "r",
    signal: new AbortController().signal,
  });

  const final = getPurchase(purchase.id);
  assert.equal(final?.status, "failed");
  assert.equal(final?.error, "openai_operator_not_implemented");
  assert.ok((final?.finished_at ?? 0) > 0);
});

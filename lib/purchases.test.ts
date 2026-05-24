import { test } from "node:test";
import assert from "node:assert";
import { randomUUID } from "node:crypto";

process.env["TERMPAY_DB_PATH"] =
  process.env["TERMPAY_DB_PATH"] ?? `/tmp/termpay-purchases-test-${randomUUID()}.sqlite`;
process.env["TERMPAY_VAULT_KEY"] =
  process.env["TERMPAY_VAULT_KEY"] ??
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const { db } = await import("./db.ts");
const {
  createPurchase,
  getPurchase,
  getPurchaseForAgent,
  listPurchasesForAgent,
  updatePurchase,
} = await import("./purchases.ts");
const { MockDriver } = await import("./drivers/mock.ts");

function runMock(purchase_id: string): void {
  new MockDriver().run({
    purchase_id,
    agent_id: "",
    intent: "",
    merchant: "",
    max_amount_cents: 0,
    reason: "",
    signal: new AbortController().signal,
  });
}

function seedAgent(): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO agents (id, name, api_key_hash, monthly_limit_cents, per_tx_limit_cents, status, created_at)
     VALUES (?, 'test', 'hash', 10000, 5000, 'active', ?)`,
  ).run(id, Date.now());
  return id;
}

test("createPurchase inserts row and returns created=true", () => {
  const agent_id = seedAgent();
  const { purchase, created } = createPurchase({
    agent_id,
    agent_name: "claude-code",
    intent: "buy widget",
    merchant: "amazon.com",
    max_amount_cents: 1500,
    reason: "test",
    idempotency_key: `k-${randomUUID()}`,
    driver: "mock",
  });
  assert.equal(created, true);
  assert.equal(purchase.status, "running");
  assert.equal(purchase.merchant, "amazon.com");
  assert.equal(purchase.max_amount_cents, 1500);
  assert.equal(purchase.driver, "mock");
  assert.equal(purchase.finished_at, null);
});

test("createPurchase is idempotent on (agent_id, idempotency_key)", () => {
  const agent_id = seedAgent();
  const key = `k-${randomUUID()}`;
  const first = createPurchase({
    agent_id, agent_name: null, intent: "i1", merchant: "amazon.com",
    max_amount_cents: 500, reason: "r1", idempotency_key: key, driver: "mock",
  });
  const second = createPurchase({
    agent_id, agent_name: null, intent: "i2-different", merchant: "amazon.com",
    max_amount_cents: 999, reason: "r2-different", idempotency_key: key, driver: "mock",
  });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.purchase.id, first.purchase.id);
  assert.equal(second.purchase.intent, "i1"); // original preserved

  // Exactly one row exists for this key
  const rows = db
    .prepare("SELECT COUNT(*) as n FROM purchases WHERE agent_id = ? AND idempotency_key = ?")
    .get(agent_id, key) as { n: number };
  assert.equal(rows.n, 1);
});

test("getPurchaseForAgent enforces agent_id ownership", () => {
  const agent_a = seedAgent();
  const agent_b = seedAgent();
  const { purchase } = createPurchase({
    agent_id: agent_a, agent_name: null, intent: "x", merchant: "amazon.com",
    max_amount_cents: 100, reason: "r", idempotency_key: `k-${randomUUID()}`, driver: "mock",
  });
  assert.ok(getPurchaseForAgent(purchase.id, agent_a));
  assert.equal(getPurchaseForAgent(purchase.id, agent_b), undefined);
});

test("listPurchasesForAgent returns newest first", () => {
  const agent_id = seedAgent();
  const a = createPurchase({
    agent_id, agent_name: null, intent: "first", merchant: "amazon.com",
    max_amount_cents: 100, reason: "r", idempotency_key: `k-${randomUUID()}`, driver: "mock",
  }).purchase;
  const b = createPurchase({
    agent_id, agent_name: null, intent: "second", merchant: "amazon.com",
    max_amount_cents: 100, reason: "r", idempotency_key: `k-${randomUUID()}`, driver: "mock",
  }).purchase;
  const list = listPurchasesForAgent(agent_id, 10);
  const ids = list.map((p) => p.id);
  assert.ok(ids.indexOf(b.id) < ids.indexOf(a.id), "newest first");
});

test("updatePurchase patches only provided fields", () => {
  const agent_id = seedAgent();
  const { purchase } = createPurchase({
    agent_id, agent_name: null, intent: "x", merchant: "amazon.com",
    max_amount_cents: 100, reason: "r", idempotency_key: `k-${randomUUID()}`, driver: "mock",
  });
  const updated = updatePurchase(purchase.id, { progress: "halfway" });
  assert.equal(updated?.progress, "halfway");
  assert.equal(updated?.status, "running"); // untouched
  assert.equal(updated?.intent, "x"); // untouched
});

test("MockDriver moves purchase to succeeded with evidence", async () => {
  const agent_id = seedAgent();
  const { purchase } = createPurchase({
    agent_id, agent_name: null, intent: "x", merchant: "amazon.com",
    max_amount_cents: 100, reason: "r", idempotency_key: `k-${randomUUID()}`, driver: "mock",
  });
  runMock(purchase.id);
  await new Promise((r) => setTimeout(r, 3500));
  const final = getPurchase(purchase.id);
  assert.equal(final?.status, "succeeded");
  assert.equal(final?.evidence, "MOCK_DRIVER");
  assert.ok((final?.finished_at ?? 0) >= (final?.started_at ?? 0));
});

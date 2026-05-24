import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, Payment } from "./types.ts";

// Must be set before importing db-dependent modules (ESM caches on first load)
const testDbPath = join(tmpdir(), `termpay-test-${randomBytes(4).toString("hex")}.sqlite`);
process.env["TERMPAY_DB_PATH"] = testDbPath;
process.env["TERMPAY_VAULT_KEY"] = randomBytes(32).toString("hex");

// Dynamic imports so env vars above apply on first load
const { runPay } = await import("./pay.ts");
const { db } = await import("./db.ts");
const { encryptCard } = await import("./vault.ts");

after(() => {
  try { db.close(); } catch { /* ignore */ }
  if (existsSync(testDbPath)) unlinkSync(testDbPath);
});

// ── shared fixtures ────────────────────────────────────────────────────────────

const agentId = `agent-${randomBytes(4).toString("hex")}`;

db.prepare(
  `INSERT INTO agents
     (id, name, api_key_hash, monthly_limit_cents, per_tx_limit_cents, status, created_at)
   VALUES (?, 'Test Agent', 'testhash', 10000, 2000, 'active', ?)`,
).run(agentId, Date.now());

const cardBlob = encryptCard({
  pan: "4111111111111111",
  exp_month: 12,
  exp_year: 2030,
  name: "Test User",
});
db.prepare(
  `INSERT OR REPLACE INTO settings
     (id, encrypted_card, card_last4, card_brand, card_exp, vault_key_id, created_at)
   VALUES (1, ?, '1111', 'visa', '12/30', 'test', ?)`,
).run(cardBlob, Date.now());

const testAgent = db
  .prepare("SELECT * FROM agents WHERE id = ?")
  .get(agentId) as unknown as Agent;

interface TestPayInput {
  agent: Agent;
  amount_cents: number;
  merchant: string;
  merchant_url: string | undefined;
  reason: string;
  idempotency_key: string;
  cvv: string;
}

function makeInput(extra?: Partial<TestPayInput>): TestPayInput {
  return {
    agent: testAgent,
    amount_cents: 500,
    merchant: "console.anthropic.com",
    merchant_url: undefined,
    reason: "Test payment",
    idempotency_key: `key-${randomBytes(4).toString("hex")}`,
    cvv: "123",
    ...extra,
  };
}

// ── tests ──────────────────────────────────────────────────────────────────────

test("pay: idempotent — duplicate key returns original row, exactly one DB row", async () => {
  const input = makeInput();
  const r1 = await runPay(input);
  const r2 = await runPay(input);

  assert.ok(r1.ok, "first call should succeed");
  assert.ok(r2.ok, "second call should succeed");
  assert.deepEqual(r1, r2, "both calls return identical result");

  const rows = db
    .prepare("SELECT * FROM payments WHERE agent_id = ? AND idempotency_key = ?")
    .all(agentId, input.idempotency_key);
  assert.equal((rows as unknown[]).length, 1, "exactly one row in DB");
});

test("pay: denied when agent is killed", async () => {
  const killedAgent: Agent = { ...testAgent, status: "killed" };
  const r = await runPay(makeInput({ agent: killedAgent }));

  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, "agent_killed");
});

test("pay: denied when amount exceeds per-tx limit", async () => {
  const r = await runPay(makeInput({ amount_cents: 999999 }));

  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, "per_tx_limit_exceeded");
});

test("pay: inserts pending then updates to succeeded (stub)", async () => {
  const input = makeInput();
  const r = await runPay(input);

  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.payment.status, "succeeded");
    assert.equal(r.payment.evidence, "STUB");
    assert.equal(r.payment.merchant, "console.anthropic.com");
  }
});

#!/usr/bin/env node
import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { render } from "ink";
import { db } from "../lib/db.ts";
import { generateApiKey, getAgentByApiKey } from "../lib/agent-keys.ts";
import { encryptCard } from "../lib/vault.ts";
import { dollarsToCents, formatUSD } from "../lib/money.ts";
import type { Agent, Payment } from "../lib/types.ts";
import { TuiApp } from "./tui.tsx";

const program = new Command();
program
  .name("termpay")
  .description("Let AI agents pay autonomously within limits you set.")
  .version("0.0.1");

// ── setup ──────────────────────────────────────────────────────────────────────

program
  .command("setup")
  .description("Add or replace your payment card")
  .action(async () => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const pan = (await rl.question("Card number: ")).replace(/\s+/g, "");
      const expMonthStr = await rl.question("Expiry month (1-12): ");
      const expYearStr = await rl.question("Expiry year (YYYY): ");
      const name = await rl.question("Name on card: ");
      const brand = await rl.question("Brand (visa/mastercard/amex/discover): ");

      const exp_month = parseInt(expMonthStr, 10);
      const exp_year = parseInt(expYearStr, 10);
      if (isNaN(exp_month) || exp_month < 1 || exp_month > 12) {
        console.error("Invalid expiry month");
        process.exit(1);
      }
      if (isNaN(exp_year) || exp_year < 2024) {
        console.error("Invalid expiry year");
        process.exit(1);
      }

      const last4 = pan.slice(-4);
      const exp = `${String(exp_month).padStart(2, "0")}/${String(exp_year).slice(-2)}`;
      const blob = encryptCard({ pan, exp_month, exp_year, name });

      db.prepare(
        `INSERT OR REPLACE INTO settings
           (id, encrypted_card, card_last4, card_brand, card_exp, vault_key_id, created_at)
         VALUES (1, ?, ?, ?, ?, 'keychain-v1', ?)`,
      ).run(blob, last4, brand.toLowerCase(), exp, Date.now());

      console.log(`Card saved: **** ${last4}  ${exp}  ${brand.toLowerCase()}`);
    } finally {
      rl.close();
    }
  });

// ── agent ──────────────────────────────────────────────────────────────────────

const agentCmd = program.command("agent").description("Manage agents");

agentCmd
  .command("add <name>")
  .description("Create a new agent and print its API key")
  .requiredOption("--monthly <usd>", "Monthly spending limit in USD")
  .requiredOption("--per-tx <usd>", "Per-transaction limit in USD")
  .action((name: string, opts: { monthly: string; perTx: string }) => {
    const monthly_limit_cents = dollarsToCents(parseFloat(opts.monthly));
    const per_tx_limit_cents = dollarsToCents(parseFloat(opts.perTx));
    if (!isFinite(monthly_limit_cents) || !isFinite(per_tx_limit_cents)) {
      console.error("Invalid limit values");
      process.exit(1);
    }
    const { raw, hash } = generateApiKey();
    const id = randomUUID();
    db.prepare(
      `INSERT INTO agents
         (id, name, api_key_hash, monthly_limit_cents, per_tx_limit_cents, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`,
    ).run(id, name, hash, monthly_limit_cents, per_tx_limit_cents, Date.now());
    console.log(`Agent created: ${id}  name="${name}"`);
    console.log(`Monthly: ${formatUSD(monthly_limit_cents)}  Per-tx: ${formatUSD(per_tx_limit_cents)}`);
    console.log(`API key (shown once — save it): ${raw}`);
  });

agentCmd
  .command("list")
  .description("List all agents")
  .action(() => {
    const agents = db
      .prepare("SELECT * FROM agents ORDER BY created_at ASC")
      .all() as unknown as Agent[];
    if (agents.length === 0) {
      console.log("No agents. Run: termpay agent add <name> --monthly <usd> --per-tx <usd>");
      return;
    }
    console.log(
      `${"ID".padEnd(36)}  ${"NAME".padEnd(20)}  ${"STATUS".padEnd(8)}  MONTHLY      PER-TX`,
    );
    for (const a of agents) {
      console.log(
        `${a.id.padEnd(36)}  ${a.name.padEnd(20)}  ${a.status.padEnd(8)}  ${formatUSD(a.monthly_limit_cents).padEnd(12)}${formatUSD(a.per_tx_limit_cents)}`,
      );
    }
  });

agentCmd
  .command("kill <id>")
  .description("Kill an agent permanently")
  .action((id: string) => {
    const result = db
      .prepare("UPDATE agents SET status = 'killed' WHERE id = ?")
      .run(id);
    if ((result as { changes: number }).changes === 0) {
      console.error(`No agent with id: ${id}`);
      process.exit(1);
    }
    console.log(`Agent ${id} killed.`);
  });

// ── pay ────────────────────────────────────────────────────────────────────────
// Phase 1 stub: authenticates agent, inserts payment row with status='succeeded'
// and evidence='STUB'. Phase 2 adds vault decrypt + policy + real checkout.

program
  .command("pay")
  .description("Submit a payment (Phase 1: stub checkout)")
  .requiredOption("--amount <cents>", "Amount in cents")
  .requiredOption("--merchant <host>", "Merchant hostname")
  .requiredOption("--reason <text>", "Reason for this payment")
  .requiredOption("--idempotency-key <key>", "Idempotency key")
  .option("--url <url>", "Exact checkout URL")
  .action(
    (opts: {
      amount: string;
      merchant: string;
      reason: string;
      idempotencyKey: string;
      url?: string;
    }) => {
      const apiKey = process.env["TERMPAY_API_KEY"] ?? "";
      const agent = getAgentByApiKey(apiKey);
      if (!agent) {
        process.stderr.write(JSON.stringify({ error: "invalid_api_key" }) + "\n");
        process.exit(1);
      }

      // Idempotency: return original row on duplicate key
      const existing = db
        .prepare("SELECT * FROM payments WHERE agent_id = ? AND idempotency_key = ?")
        .get(agent.id, opts.idempotencyKey) as unknown as Payment | undefined;
      if (existing) {
        process.stdout.write(JSON.stringify(existing) + "\n");
        return;
      }

      const amount_cents = parseInt(opts.amount, 10);
      if (isNaN(amount_cents) || amount_cents <= 0) {
        process.stderr.write(JSON.stringify({ error: "invalid_amount" }) + "\n");
        process.exit(1);
      }

      const id = randomUUID();
      const now = Date.now();
      db.prepare(
        `INSERT INTO payments
           (id, agent_id, amount_cents, merchant, merchant_url, reason,
            status, evidence, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'succeeded', 'STUB', ?, ?)`,
      ).run(id, agent.id, amount_cents, opts.merchant, opts.url ?? null, opts.reason, opts.idempotencyKey, now);

      const row = db
        .prepare("SELECT * FROM payments WHERE id = ?")
        .get(id) as unknown as Payment;
      process.stdout.write(JSON.stringify(row) + "\n");
    },
  );

// ── payments ───────────────────────────────────────────────────────────────────

const paymentsCmd = program
  .command("payments")
  .description("List payments or reconcile an unknown one");

paymentsCmd
  .option("-l, --limit <n>", "Max rows to show", "20")
  .action((opts: { limit: string }) => {
    const limit = parseInt(opts.limit, 10);
    const rows = db
      .prepare("SELECT * FROM payments ORDER BY created_at DESC LIMIT ?")
      .all(limit) as unknown as Payment[];
    if (rows.length === 0) {
      console.log("No payments yet.");
      return;
    }
    console.log(`${"ID".padEnd(36)}  ${"MERCHANT".padEnd(30)}  ${"AMOUNT".padEnd(9)} STATUS`);
    for (const p of rows) {
      console.log(
        `${p.id.padEnd(36)}  ${p.merchant.padEnd(30)}  ${formatUSD(p.amount_cents).padEnd(9)}${p.status}`,
      );
    }
  });

paymentsCmd
  .command("reconcile <id>")
  .description("Manually set status of an unknown payment")
  .requiredOption("--status <status>", "New status: succeeded|failed")
  .action((id: string, opts: { status: string }) => {
    if (!["succeeded", "failed"].includes(opts.status)) {
      console.error("--status must be 'succeeded' or 'failed'");
      process.exit(1);
    }
    const result = db
      .prepare("UPDATE payments SET status = ? WHERE id = ? AND status = 'unknown'")
      .run(opts.status, id);
    if ((result as { changes: number }).changes === 0) {
      console.error(`Payment ${id} not found or status is not 'unknown'`);
      process.exit(1);
    }
    console.log(`Payment ${id} reconciled → ${opts.status}`);
  });

// ── ui ─────────────────────────────────────────────────────────────────────────

program
  .command("ui")
  .description("Launch the interactive terminal UI")
  .action(async () => {
    const { waitUntilExit } = render(createElement(TuiApp));
    await waitUntilExit();
  });

program.parse();

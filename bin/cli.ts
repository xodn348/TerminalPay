#!/usr/bin/env node
import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { render } from "ink";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../lib/db.ts";
import { generateApiKey, getAgentByApiKey } from "../lib/agent-keys.ts";
import { encryptCard } from "../lib/vault.ts";
import { dollarsToCents, formatUSD } from "../lib/money.ts";
import { runPay } from "../lib/pay.ts";
import type { Agent, Payment } from "../lib/types.ts";

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
  .description("Submit a payment request (checkout stub; Phase 3 wires real browser)")
  .requiredOption("--amount <cents>", "Amount in cents")
  .requiredOption("--merchant <host>", "Merchant hostname")
  .requiredOption("--reason <text>", "Reason for this payment")
  .requiredOption("--idempotency-key <key>", "Idempotency key")
  .option("--url <url>", "Exact checkout URL")
  .action(
    async (opts: {
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

      const amount_cents = parseInt(opts.amount, 10);
      if (isNaN(amount_cents) || amount_cents <= 0) {
        process.stderr.write(JSON.stringify({ error: "invalid_amount" }) + "\n");
        process.exit(1);
      }

      // CVV: env var first, then interactive prompt on TTY
      let cvv = process.env["TERMPAY_CARD_CVV"] ?? "";
      if (!cvv && process.stdin.isTTY) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        cvv = await rl.question("Card CVV: ");
        rl.close();
      }
      if (!cvv) {
        process.stderr.write(
          JSON.stringify({ error: "cvv_required: set TERMPAY_CARD_CVV or run interactively" }) + "\n",
        );
        process.exit(1);
      }

      const result = await runPay({
        agent,
        amount_cents,
        merchant: opts.merchant,
        merchant_url: opts.url,
        reason: opts.reason,
        idempotency_key: opts.idempotencyKey,
        cvv,
      });

      if (!result.ok) {
        process.stderr.write(JSON.stringify({ error: result.error }) + "\n");
        process.exit(1);
      }
      process.stdout.write(JSON.stringify(result.payment) + "\n");
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

// ── browser ────────────────────────────────────────────────────────────────────

const browserCmd = program
  .command("browser")
  .description("Manage merchant browser sessions (for multi-step purchases)");

browserCmd
  .command("login <merchant>")
  .description(
    "Open Chromium to log in to a merchant. Cookies are saved encrypted at " +
      "~/.termpay/cookies/<merchant>.enc and reused by the purchase driver.",
  )
  .action(async (merchant: string) => {
    const { chromium } = await import("patchright");
    const { saveCookies } = await import("../lib/cookies.ts");

    console.log(`Launching Chromium for ${merchant}…`);
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();
    const url = merchant.startsWith("http") ? merchant : `https://${merchant}`;
    await page.goto(url);

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await rl.question("Press Enter once you're logged in (then we'll save cookies)… ");
    rl.close();

    const cookies = await context.cookies();
    await context.close();
    await browser.close();

    saveCookies(merchant, cookies);
    console.log(
      `Saved ${cookies.length} cookies (encrypted) for ${merchant}. ` +
        `The purchase driver will reuse this session.`,
    );
  });

browserCmd
  .command("logout <merchant>")
  .description("Delete saved cookies for a merchant")
  .action(async (merchant: string) => {
    const { deleteCookies } = await import("../lib/cookies.ts");
    const removed = deleteCookies(merchant);
    console.log(removed ? `Removed cookies for ${merchant}` : `No saved cookies for ${merchant}`);
  });

browserCmd
  .command("list")
  .description("List merchants with saved cookies")
  .action(async () => {
    const { listSavedMerchants } = await import("../lib/cookies.ts");
    const all = listSavedMerchants();
    if (all.length === 0) {
      console.log("No saved logins. Run: termpay browser login <merchant>");
      return;
    }
    for (const m of all) console.log(m);
  });

// ── ui ─────────────────────────────────────────────────────────────────────────

program
  .command("ui")
  .description("Launch the interactive terminal UI")
  .action(async () => {
    const { TuiApp } = await import("./tui.tsx");
    const { waitUntilExit } = render(createElement(TuiApp));
    await waitUntilExit();
  });

// ── mcp ────────────────────────────────────────────────────────────────────────

const mcpCmd = program.command("mcp").description("Manage MCP server integration");

mcpCmd
  .command("install")
  .description("Write MCP config snippets to detected AI client configs")
  .option("--key <key>", "API key to embed (prompts if absent and TTY is attached)")
  .action(async (opts: { key?: string }) => {
    // Resolve the mcp-server.ts path relative to this file
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const serverPath = join(__dirname, "mcp-server.ts");

    let apiKey = opts.key ?? process.env["TERMPAY_API_KEY"] ?? "";
    if (!apiKey && process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      apiKey = (await rl.question("Termpay API key (from termpay agent add): ")).trim();
      rl.close();
    }
    if (!apiKey) {
      console.error("No API key. Create one with: termpay agent add <name> --monthly <usd> --per-tx <usd>");
      process.exit(1);
    }

    const serverEntry = {
      command: "node",
      args: ["--experimental-strip-types", serverPath],
      env: {
        TERMPAY_API_KEY: apiKey,
        // TERMPAY_CARD_CVV must be set by the user in their shell for the session.
      },
    };

    type ClientConfig = { name: string; configPath: string };
    const clients: ClientConfig[] = [
      {
        name: "Claude Code",
        configPath: join(homedir(), ".claude.json"),
      },
      {
        name: "Claude Desktop (macOS)",
        configPath: join(
          homedir(),
          "Library",
          "Application Support",
          "Claude",
          "claude_desktop_config.json",
        ),
      },
      {
        name: "Cursor",
        configPath: join(homedir(), ".cursor", "mcp.json"),
      },
    ];

    let wrote = 0;
    for (const client of clients) {
      const dir = dirname(client.configPath);
      if (!existsSync(dir)) continue; // client not installed — skip silently

      let config: Record<string, unknown> = {};
      if (existsSync(client.configPath)) {
        try {
          config = JSON.parse(readFileSync(client.configPath, "utf8")) as Record<string, unknown>;
        } catch {
          config = {};
        }
      }

      const mcpServers = (config["mcpServers"] as Record<string, unknown> | undefined) ?? {};
      mcpServers["termpay"] = serverEntry;
      config["mcpServers"] = mcpServers;

      writeFileSync(client.configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
      console.log(`Written: ${client.name}  (${client.configPath})`);
      wrote++;
    }

    if (wrote === 0) {
      console.log("No supported AI clients detected. Manually add the following MCP server entry:");
      console.log(JSON.stringify({ termpay: serverEntry }, null, 2));
    } else {
      console.log(`\nRestart your AI client to activate the termpay MCP server.`);
      console.log(`Set TERMPAY_CARD_CVV in your shell before starting each session.`);
    }
  });

program.parse();

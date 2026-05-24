#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { db } from "../lib/db.ts";
import { runPay } from "../lib/pay.ts";
import { evaluate } from "../lib/policy.ts";
import { getAgentByApiKey } from "../lib/agent-keys.ts";
import { dollarsToCents, formatUSD } from "../lib/money.ts";
import { recordOrder, listOrders } from "../lib/orders.ts";
import { createPurchase, getPurchaseForAgent } from "../lib/purchases.ts";
import { runMockDriver } from "../lib/drivers/mock.ts";
import type { Agent, Payment } from "../lib/types.ts";

const server = new McpServer(
  { name: "termpay", version: "0.0.1" },
  {
    instructions: `Termpay: lets AI agents pay autonomously within limits the user controls.

Authentication: set TERMPAY_API_KEY to the agent's API key (termpay agent add <name>).
CVV: set TERMPAY_CARD_CVV before starting the MCP server for the session.

Tools:
- pay         — submit a payment (amount in USD, e.g. 5.0 for $5)
- purchase    — multi-step e-commerce (Amazon/Etsy/etc.); async, returns purchase_id
- purchase_status — poll a purchase by id
- policy      — check if a payment would be approved without charging
- payments    — list recent payments for this agent
- orders      — list recorded orders
- kill        — permanently kill an agent
- record_order — attach order details (items, tracking) to a payment

Always include a clear reason. Use a stable idempotency_key (hash of intent)
to prevent duplicate charges on retries.`,
  },
);

// Capture MCP client name for audit attribution after the initialize handshake.
let mcpClientName = "unknown";
server.server.oninitialized = () => {
  mcpClientName = server.server.getClientVersion()?.name ?? "unknown";
};

function requireAgent(): Agent {
  const key = process.env["TERMPAY_API_KEY"] ?? "";
  const agent = getAgentByApiKey(key);
  if (!agent) {
    throw new Error(
      "TERMPAY_API_KEY not set or invalid. " +
      "Run: termpay agent add <name> --monthly <usd> --per-tx <usd>",
    );
  }
  return agent;
}

// ── tool: pay ─────────────────────────────────────────────────────────────────

server.registerTool(
  "pay",
  {
    description:
      "Submit a payment for the authenticated agent. " +
      "Amount is in USD as a decimal number (5.0 = $5.00). " +
      "Requires TERMPAY_API_KEY and TERMPAY_CARD_CVV on the server process. " +
      "Re-submitting the same idempotency_key is safe — returns the original result without re-charging. " +
      "Returns JSON with the payment row; isError=true if denied.",
    inputSchema: {
      amount: z.number().positive().describe("Amount in USD (e.g. 5.0)"),
      merchant: z.string().min(1).describe("Merchant hostname (e.g. console.anthropic.com)"),
      reason: z.string().min(1).describe("Human-readable reason for this payment"),
      idempotency_key: z
        .string()
        .min(1)
        .describe("Stable unique key — same key returns the original result without re-charging"),
      url: z
        .string()
        .url()
        .optional()
        .describe("Exact checkout URL (optional; overrides the default for this merchant)"),
    },
  },
  async (args) => {
    const agent = requireAgent();
    const amount_cents = dollarsToCents(args.amount);
    const cvv = process.env["TERMPAY_CARD_CVV"] ?? "";
    if (!cvv) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: "cvv_required: set TERMPAY_CARD_CVV on the MCP server process" }),
          },
        ],
        isError: true,
      };
    }

    const result = await runPay({
      agent,
      agent_name: mcpClientName,
      amount_cents,
      merchant: args.merchant,
      merchant_url: args.url,
      reason: args.reason,
      idempotency_key: args.idempotency_key,
      cvv,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result.ok ? result.payment : { error: result.error }),
        },
      ],
      isError: !result.ok,
    };
  },
);

// ── tool: purchase ────────────────────────────────────────────────────────────
// Async: returns immediately with purchase_id. A background driver (mock in
// PR-A; anthropic_computer_use in PR-D) drives the merchant checkout and
// updates the purchases row. Poll status with `purchase_status`.

server.registerTool(
  "purchase",
  {
    description:
      "Make a multi-step purchase on a merchant (Amazon, Etsy, Shopify, etc.). " +
      "Asynchronous — returns purchase_id immediately; poll with purchase_status. " +
      "termpay launches a local browser, drives the checkout, and fills the card at the " +
      "payment moment without exposing it to the LLM driver context. " +
      "max_amount in USD caps the total — the purchase is aborted if the cart exceeds it. " +
      "Re-using the same idempotency_key returns the original purchase without starting a new one.",
    inputSchema: {
      intent: z
        .string()
        .min(1)
        .describe(
          "What to buy, in natural language (e.g. 'buy this exact URL: https://www.amazon.com/dp/B0XXX')",
        ),
      merchant: z.string().min(1).describe("Merchant hostname (e.g. amazon.com)"),
      max_amount: z
        .number()
        .positive()
        .describe("Max total amount in USD; abort if cart exceeds this"),
      reason: z.string().min(1).describe("Human-readable reason"),
      idempotency_key: z
        .string()
        .min(1)
        .describe("Stable unique key — same key returns the original purchase"),
    },
  },
  (args) => {
    const agent = requireAgent();
    const max_amount_cents = dollarsToCents(args.max_amount);

    const { purchase, created } = createPurchase({
      agent_id: agent.id,
      agent_name: mcpClientName,
      intent: args.intent,
      merchant: args.merchant,
      max_amount_cents,
      reason: args.reason,
      idempotency_key: args.idempotency_key,
      driver: "mock", // PR-D switches this based on env / availability
    });

    if (created) runMockDriver(purchase.id);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            purchase_id: purchase.id,
            status: purchase.status,
            idempotent_replay: !created,
          }),
        },
      ],
    };
  },
);

// ── tool: purchase_status ─────────────────────────────────────────────────────

server.registerTool(
  "purchase_status",
  {
    description:
      "Poll a purchase started by `purchase`. Returns the current status, progress note, " +
      "and any final fields (payment_id, order_id, evidence, error). Status enum: " +
      "running | awaiting_human | succeeded | failed | denied | unknown.",
    inputSchema: {
      purchase_id: z.string().uuid().describe("ID returned by `purchase`"),
    },
  },
  (args) => {
    const agent = requireAgent();
    const row = getPurchaseForAgent(args.purchase_id, agent.id);
    if (!row) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: "purchase_not_found", purchase_id: args.purchase_id }),
          },
        ],
        isError: true,
      };
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(row) }],
    };
  },
);

// ── tool: policy ──────────────────────────────────────────────────────────────

server.registerTool(
  "policy",
  {
    description:
      "Check whether a payment would be approved by the current policy, without charging. " +
      "Returns approved, the deny reason if applicable, and the remaining budget.",
    inputSchema: {
      amount: z.number().positive().describe("Amount in USD (e.g. 5.0)"),
      merchant: z.string().min(1).describe("Merchant hostname"),
    },
  },
  (args) => {
    const agent = requireAgent();
    const amount_cents = dollarsToCents(args.amount);

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const spentRow = db
      .prepare(
        "SELECT COALESCE(SUM(amount_cents), 0) as total FROM payments " +
          "WHERE agent_id = ? AND status = 'succeeded' AND created_at >= ?",
      )
      .get(agent.id, monthStart) as unknown as { total: number };

    const decision = evaluate({
      agent,
      amount_cents,
      monthly_spent_cents: spentRow.total,
    });

    const remaining = Math.max(0, agent.monthly_limit_cents - spentRow.total);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            approved: decision.outcome === "approve",
            reason: decision.reasons[0] ?? "unknown",
            amount: formatUSD(amount_cents),
            per_tx_limit: formatUSD(agent.per_tx_limit_cents),
            monthly_remaining: formatUSD(remaining),
          }),
        },
      ],
    };
  },
);

// ── tool: payments ────────────────────────────────────────────────────────────

server.registerTool(
  "payments",
  {
    description: "List recent payments for the authenticated agent, newest first.",
    inputSchema: {
      limit: z
        .number()
        .int()
        .positive()
        .max(100)
        .default(20)
        .describe("Max rows to return (default 20, max 100)"),
    },
  },
  (args) => {
    const agent = requireAgent();
    const rows = db
      .prepare(
        "SELECT id, agent_name, amount_cents, merchant, reason, status, created_at, idempotency_key " +
          "FROM payments WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(agent.id, args.limit) as unknown as Pick<
      Payment,
      "id" | "agent_name" | "amount_cents" | "merchant" | "reason" | "status" | "created_at" | "idempotency_key"
    >[];

    return {
      content: [{ type: "text" as const, text: JSON.stringify(rows) }],
    };
  },
);

// ── tool: orders ──────────────────────────────────────────────────────────────

server.registerTool(
  "orders",
  {
    description: "List recorded orders (items, tracking info) linked to payments, newest first.",
    inputSchema: {
      limit: z
        .number()
        .int()
        .positive()
        .max(100)
        .default(20)
        .describe("Max rows to return (default 20, max 100)"),
    },
  },
  (args) => {
    const rows = listOrders(args.limit);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(rows) }],
    };
  },
);

// ── tool: kill ────────────────────────────────────────────────────────────────

server.registerTool(
  "kill",
  {
    description:
      "Permanently kill an agent — all future pay calls by that agent are denied immediately. " +
      "This cannot be undone via the API; use the TUI or CLI to manage agents.",
    inputSchema: {
      agent_id: z.string().uuid().describe("Agent ID to kill (visible in payments or agent list)"),
    },
  },
  (args) => {
    const result = db
      .prepare("UPDATE agents SET status = 'killed' WHERE id = ?")
      .run(args.agent_id) as { changes: number };

    if (result.changes === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: "agent_not_found", agent_id: args.agent_id }),
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ killed: true, agent_id: args.agent_id }),
        },
      ],
    };
  },
);

// ── tool: record_order ────────────────────────────────────────────────────────

server.registerTool(
  "record_order",
  {
    description:
      "Record order details (items, shipping, tracking) after a payment succeeds. " +
      "Attach fulfillment data to a payment row for the orders view.",
    inputSchema: {
      payment_id: z.string().uuid().describe("ID of the related payment"),
      merchant_order_id: z.string().optional().describe("Order ID from the merchant's system"),
      items: z
        .array(z.record(z.unknown()))
        .optional()
        .describe("Line items array (e.g. [{name, qty, price}])"),
      shipping_address: z
        .record(z.unknown())
        .optional()
        .describe("Shipping address object"),
      carrier: z.string().optional().describe("Carrier name (e.g. UPS, FedEx)"),
      tracking_number: z.string().optional().describe("Shipment tracking number"),
    },
  },
  (args) => {
    const order = recordOrder({
      payment_id: args.payment_id,
      merchant_order_id: args.merchant_order_id ?? null,
      items: args.items,
      shipping_address: args.shipping_address,
      carrier: args.carrier ?? null,
      tracking_number: args.tracking_number ?? null,
    });

    return {
      content: [{ type: "text" as const, text: JSON.stringify(order) }],
    };
  },
);

// ── start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);

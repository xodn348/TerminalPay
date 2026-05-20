/**
 * AgentWallet MCP stdio server.
 *
 * Bridges an MCP client (Claude Desktop, Cursor, Cline, etc.) to the local
 * AgentWallet HTTP API. Exposes three tools:
 *   - `pay`                    → forwards to POST /api/pay
 *   - `check_balance`          → derived monthly spend (client-side)
 *   - `list_recent_payments`   → forwards to GET /api/payments
 *
 * Launched via `pnpm mcp` (which runs `tsx bin/mcp.ts`). Reads:
 *   - `AGENTWALLET_API_KEY`  (required) — raw `ak_...` Bearer token
 *   - `AGENTWALLET_BASE_URL` (optional) — defaults to http://localhost:3000
 */
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  AgentWalletClient,
  AgentWalletHttpError,
} from "@/lib/client-sdk";

/**
 * Build a successful tool response containing pretty-printed JSON.
 *
 * We always return a single text block — MCP clients render JSON cleanly
 * and the model can parse it directly.
 */
function jsonResponse(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

/**
 * Build an error tool response. The MCP client surfaces `isError: true`
 * separately from a transport-level failure.
 */
function errorResponse(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

/**
 * Convert a thrown error into a JSON-serializable shape for `errorResponse`.
 */
function describeError(err: unknown): Record<string, unknown> {
  if (err instanceof AgentWalletHttpError) {
    return {
      error_code: err.code,
      error_message: err.message,
      status: err.status ?? null,
      retryable: err.retryable,
      body: err.body ?? null,
    };
  }
  if (err instanceof Error) {
    return {
      error_code: "unexpected_error",
      error_message: err.message,
    };
  }
  return {
    error_code: "unexpected_error",
    error_message: String(err),
  };
}

// ---------------------------------------------------------------------------
// Tool input schemas (zod raw shapes, as McpServer.registerTool expects).
// ---------------------------------------------------------------------------

const payInputShape = {
  amount_cents: z
    .number()
    .int()
    .min(1)
    .describe("Payment amount in USD cents. Integer >= 1."),
  merchant: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("Merchant name (1..200 chars)."),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .describe(
      "Human-meaningful explanation of WHY this payment is being made. " +
        "Required for audit. Avoid placeholders like 'test' or single " +
        "characters — the wallet may reject low-quality reasons.",
    ),
  idempotency_key: z
    .string()
    .min(8)
    .max(128)
    .optional()
    .describe(
      "Optional dedup token (8..128 chars). If omitted, the MCP server " +
        "generates a UUID. Retries with the same key return the original " +
        "result without re-charging.",
    ),
};

const checkBalanceInputShape = {};

const listRecentPaymentsInputShape = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Maximum payments to return (1..200, default 20)."),
};

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/**
 * Read required env vars, log to stderr and exit(1) on misconfiguration.
 *
 * Logging goes to stderr because stdout carries the MCP JSON-RPC frame.
 */
function loadConfig(): { apiKey: string; baseUrl: string } {
  const apiKey = process.env.AGENTWALLET_API_KEY;
  if (!apiKey) {
    process.stderr.write(
      "agentwallet-mcp: AGENTWALLET_API_KEY env var is required.\n" +
        "Create an agent at http://localhost:3000/agents/new and copy the ak_... key.\n",
    );
    process.exit(1);
  }
  const baseUrl = process.env.AGENTWALLET_BASE_URL ?? "http://localhost:3000";
  return { apiKey, baseUrl };
}

/**
 * Register the three tools on the given server. Each handler catches errors
 * and routes them through {@link errorResponse} so the MCP client gets a
 * structured `isError: true` payload instead of a transport-level crash.
 */
function registerTools(server: McpServer, client: AgentWalletClient): void {
  server.registerTool(
    "pay",
    {
      title: "Make a payment",
      description:
        "Charge the user's card via AgentWallet. Every call MUST include a " +
        "human-meaningful 'reason' explaining why the agent is spending — " +
        "this is shown to the user in the dashboard and may be audited. " +
        "Returns one of three outcomes: 'succeeded' (with a payment record), " +
        "'denied' (with policy reasons; e.g. limit exceeded or agent killed), " +
        "or 'failed' (with error_code and error_message from Stripe). " +
        "Idempotent: retrying with the same idempotency_key returns the " +
        "original result without re-charging.",
      inputSchema: payInputShape,
    },
    async (args) => {
      try {
        const result = await client.pay({
          amount_cents: args.amount_cents,
          merchant: args.merchant,
          reason: args.reason,
          idempotency_key: args.idempotency_key ?? randomUUID(),
        });
        return jsonResponse(result);
      } catch (err) {
        return errorResponse(describeError(err));
      }
    },
  );

  server.registerTool(
    "check_balance",
    {
      title: "Check this agent's monthly spend",
      description:
        "Returns this agent's monthly spend in cents (sum of succeeded " +
        "payments since the start of the current UTC month). The agent's " +
        "configured per-tx and monthly limits are intentionally not visible " +
        "to the agent. Use this to gauge how much budget you have used " +
        "before making large payments.",
      inputSchema: checkBalanceInputShape,
    },
    async () => {
      try {
        const result = await client.getMonthlySpentCents();
        return jsonResponse(result);
      } catch (err) {
        return errorResponse(describeError(err));
      }
    },
  );

  server.registerTool(
    "list_recent_payments",
    {
      title: "List recent payments",
      description:
        "Returns the most recent payments visible to this AgentWallet host " +
        "(across all agents on this machine). Useful for retrospection — " +
        "what did the agent already buy and why? Default limit 20, max 200.",
      inputSchema: listRecentPaymentsInputShape,
    },
    async (args) => {
      try {
        const result = await client.listRecentPayments({ limit: args.limit });
        return jsonResponse(result);
      } catch (err) {
        return errorResponse(describeError(err));
      }
    },
  );
}

async function main(): Promise<void> {
  const { apiKey, baseUrl } = loadConfig();
  const client = new AgentWalletClient({ apiKey, baseUrl });

  const server = new McpServer({
    name: "agentwallet",
    version: "0.0.1",
  });

  registerTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Helpful one-liner to stderr so the user sees the server is alive.
  process.stderr.write(
    `agentwallet-mcp: connected (baseUrl=${baseUrl})\n`,
  );
}

main().catch((err) => {
  process.stderr.write(
    `agentwallet-mcp: fatal: ${(err as Error).message}\n`,
  );
  process.exit(1);
});

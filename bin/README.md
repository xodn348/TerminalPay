# AgentWallet MCP server

A stdio MCP server that lets an AI agent (Claude Desktop, Cursor, Cline, etc.)
spend on the user's card via the local AgentWallet Next.js app.

## Setup

1. **Configure Stripe.** Copy `.env.example` to `.env` at the repo root and set
   `STRIPE_SECRET_KEY` and `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (Stripe Test
   mode).
2. **Start the app.** `pnpm dev` — the API listens on `http://localhost:3000`.
3. **Add a card.** Visit `http://localhost:3000/setup`.
4. **Create an agent.** Visit `http://localhost:3000/agents/new`, set the
   monthly and per-tx limits, and copy the `ak_...` API key (shown once).

## Environment

| Variable | Required | Default | Notes |
|---|---|---|---|
| `AGENTWALLET_API_KEY` | yes | — | The `ak_...` token from `/agents/new`. |
| `AGENTWALLET_BASE_URL` | no | `http://localhost:3000` | Override only if the app runs elsewhere. |

## Claude Desktop config

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) — replace the absolute path with your checkout location:

```json
{
  "mcpServers": {
    "agentwallet": {
      "command": "pnpm",
      "args": ["--silent", "-C", "/absolute/path/to/agentwallet", "mcp"],
      "env": { "AGENTWALLET_API_KEY": "ak_..." }
    }
  }
}
```

Restart Claude Desktop. The three tools below will appear in the tool picker.

## Tools

- **`pay`** — charges the user's card. Requires `amount_cents`, `merchant`,
  and a human-meaningful `reason`. `idempotency_key` is optional (the server
  generates a UUID if omitted). Retries with the same key are deduped.
- **`check_balance`** — returns this agent's monthly spend in cents (sum of
  succeeded payments since the start of the current UTC month). The agent's
  configured limits are intentionally not visible to the agent.
- **`list_recent_payments`** — recent payments across all agents on this host
  (default limit 20, max 200).

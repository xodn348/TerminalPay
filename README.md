# termpay

> Let AI agents pay autonomously with your credit card — within limits you control.

Local Node.js CLI + MCP server. Your card is encrypted on your machine. Claude Code, Codex, Cursor, or any MCP-aware agent can request payments via `termpay`. Single-page billing (Anthropic Console, OpenAI, Vercel) runs through [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) (stealth Playwright fork). Multi-step merchants (Amazon, Etsy) run through [Anthropic Computer Use](https://docs.anthropic.com/en/docs/build-with-claude/computer-use) — the agent calls one tool, termpay drives the browser end-to-end and fills the card at checkout. The LLM never sees the card.

Single user, single card, single machine. No hosted service. [PROJECT.md](./PROJECT.md) is the source of truth.

## Quick start

```bash
npx termpay setup                    # card · monthly limit · per-tx limit · allowed merchants
termpay mcp install                  # writes MCP config for Claude Code / Codex / Cursor
termpay browser login amazon.com     # one-time login per multi-step merchant
export ANTHROPIC_API_KEY=sk-ant-...   # required for purchase (Computer Use)
```

Restart your agent; termpay tools appear.

## Demo

```
You:    "Top up my Anthropic credits by $20"
Claude: [calls termpay.pay]
        "$20 charged on console.anthropic.com. Balance now $47.20."

You:    "Buy this USB-C cable  https://amazon.com/dp/..."
Claude: [calls termpay.purchase, polls termpay.purchase_status]
        "Order placed. $11.50. Order #123-456-789. FedEx delivery 5/28."

You:    "Show my payments and orders this week"
Claude: [calls termpay.payments + termpay.orders + Gmail MCP]
        [renders table]

You:    "Stop all charges"
Claude: [calls termpay.kill]
        "Kill switch engaged. All charges blocked."
```

## Guardrails

Spending limits (monthly, per-tx, allowed-merchants) are enforced before any browser action. Every charge requires a `reason`, stored for audit. Kill switch is effective within one second via `AbortController`. The card is stored AES-256-GCM in `~/.termpay/db.sqlite`, key in the OS Keychain. CVV is supplied per charge and wiped after authorization. For multi-step purchases the Computer Use model signals "checkout reached"; termpay fills the card via DOM. **The card never enters the LLM context.**

## Coverage

| Category | Examples | Status |
|---|---|---|
| Single-page SaaS billing | Anthropic Console · OpenAI · Vercel · Fly · Cloudflare | ✅ Phase 1.6 |
| Multi-step Western e-commerce | Amazon · Etsy · Shopify | ✅ Phase 1.6 |
| Direct merchant billing API | Vercel · Fly · Cloudflare native | ⬜ Phase 1.7 |
| Stripe ACP / SPT merchants | ChatGPT Instant Checkout | ⬜ Phase 2+ |
| Korean PG (Coupang · Naver · Toss) | KCP · INICIS · Toss | ❌ out of scope — phone-number identity verification and bank-app push break autonomous flow |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  AGENT      Claude Code · Codex · Cursor · any MCP client       │
│                       │  MCP stdio                              │
│                       ▼                                         │
│  TERMPAY    Local Node process — one MCP server, 9 tools        │
│             policy · encrypted vault · merchant router          │
│                       │                                         │
│                       ▼                                         │
│  RAIL       patchright (single-page) · computer_use (multi-step)│
│             merchant_api · privacy_com (planned)                │
└─────────────────────────────────────────────────────────────────┘
```

## Why protocol-less (not x402 / ACP / AP2)

x402 (Coinbase), Stripe ACP, Google AP2, and Visa Trusted Agent Protocol all need merchant adoption on the other side. They cover the top 1% of merchants today and grow through 2026-2027. termpay's bet: the long tail — everyday SaaS billing, e-commerce, anything that accepts a card in a checkout form — is reachable today through stealth browser automation, with agent identity and policy enforcement handled locally. When a merchant supports a real protocol, termpay's router picks it; until then, the browser path works.

Tradeoff: chargeback protection is weaker for agent-authorized charges. You accept this explicitly via the allowed-merchants list and per-tx limit. Phase 1.7 adds [Privacy.com](https://privacy.com) single-use virtual cards as an optional rail to isolate liability without requiring Stripe Issuing or a new protocol.

## Status

Phases 0–1.6 merged. Phase 1.7 (Privacy.com rail) next. See [open issues](https://github.com/xodn348/TerminalPay/issues) for current bot-blocked items, and [docs/pitch.html](./docs/pitch.html) for the seed pitch deck.

## License

MIT (planned).

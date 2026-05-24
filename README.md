# termpay

> Let AI agents pay autonomously with your credit card — within limits you control.

A local Node.js CLI + MCP server. Your card is encrypted on your machine. Claude Code, Codex, Cursor, or any MCP-aware agent can request payments via `termpay`. For single-page billing (Anthropic, OpenAI, Vercel) termpay drives the merchant page with [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) (stealth Playwright fork). For multi-step merchants (Amazon, Etsy) termpay orchestrates [Anthropic Computer Use](https://docs.anthropic.com/en/docs/build-with-claude/computer-use) internally — the agent calls one tool, termpay drives the browser end-to-end and fills the card at the payment moment (the LLM never sees the card).

Single user, single card, single machine. No hosted service. PROJECT.md is the source of truth.

## Setup (3 minutes)

```bash
# 1. Install
npx termpay setup

#    enter card · monthly limit · per-tx limit · allowed merchants

# 2. Register with your agent
termpay mcp install
#    writes config snippets to:
#      ~/.claude/mcp.json                 (Claude Code)
#      ~/.codex/config.toml               (Codex)
#      ~/.cursor/mcp.json                 (Cursor)
#    restart your agent — termpay tools appear.

# 3. (only for multi-step merchants) Log in once per merchant
termpay browser login amazon.com
#    opens a visible Chromium, you log in, cookies persisted encrypted.

# 4. Set your Anthropic API key (only needed for `purchase`)
export ANTHROPIC_API_KEY=sk-ant-...
```

## Use it

In Claude Code / Codex / Cursor:

```
You:    "Anthropic 크레딧 $20 충전해줘"
Claude: [calls termpay.pay]
        "$20 charged on console.anthropic.com. Balance now $47.20."

You:    "Amazon에서 이 USB-C 케이블 사줘  https://amazon.com/dp/..."
Claude: [calls termpay.purchase, polls termpay.purchase_status]
        "Order placed. $11.50. Order #123-456-789. FedEx delivery 5/28."

You:    "내 결제·주문 보여줘"
Claude: [calls termpay.payments + termpay.orders + Gmail MCP for shipping]
        [renders table]

You:    "결제 다 멈춰"
Claude: [calls termpay.kill]
        "Kill switch engaged. All charges blocked."
```

## Guardrails

- **Spending limits** — monthly cap, per-tx cap, allowed-merchants list, enforced before any browser action
- **Reason required** — every charge has a `reason` string, stored for audit
- **Kill switch** — 1-second effective, kills in-flight purchases via AbortController
- **Card never leaves your machine** — AES-256-GCM in `~/.termpay/db.sqlite`, key in macOS Keychain
- **Card never enters the LLM context** — for multi-step purchases, the Computer Use LLM signals "checkout reached" and termpay's Patchright fills the card directly via DOM
- **CVV not persisted** — supplied per charge via env or stdin, wiped after auth decision, `pay` process ≤ 30 s

## What it works on today

| Category | Examples | Status |
|---|---|---|
| Single-page SaaS billing | Anthropic Console, OpenAI, Vercel, Fly, Cloudflare | ✅ G1 verification pending; rest are adapter-add work |
| Multi-step Western e-commerce | Amazon, Etsy, Shopify stores | 🟡 Phase 1.6 in progress (Anthropic Computer Use orchestration) |
| Direct merchant API | Vercel, Fly, Cloudflare native billing APIs | ⬜ Phase 1.7 |
| Stripe ACP / SPT merchants | ChatGPT Instant Checkout stores | ⬜ Phase 2+ |
| Korean PG (Coupang, Naver, Toss) | KCP, INICIS, Toss Payments | ❌ Out of scope — `휴대폰 본인인증` + bank-app push paradigm breaks autonomous flow |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  AGENT      Claude Code · Codex · Cursor · any MCP client       │
│                       │  MCP stdio                              │
│                       ▼                                         │
│  TERMPAY    Local Node process — one MCP server, 9 tools        │
│                       │  router by merchant + amount + risk     │
│                       ▼                                         │
│  RAIL       patchright (single-page) · computer_use (multi-step)│
│             merchant_api · privacy_com (planned)                │
└─────────────────────────────────────────────────────────────────┘
```

See [PROJECT.md](./PROJECT.md) for the full spec and [ROADMAP.md](./ROADMAP.md) for phase status, validation gates, and risk register.

## Why protocol-less (not x402 / ACP / AP2)

x402 (Coinbase), Stripe ACP, Google AP2, Visa Trusted Agent Protocol — all need merchant adoption on the other side. They cover the top 1% of merchants today and grow over 2026-2027. termpay's wager: **the long tail (everyday SaaS billing, e-commerce, anything that accepts a card in a checkout form) is reachable today via stealth browser automation**, with the agent identity and policy enforcement handled by termpay locally. When a merchant supports a real protocol, termpay's router picks it; until then, the browser path works.

This trades chargeback protection (your bank won't dispute charges you "authorized" by setting up an automated tool) for coverage breadth. You accept that risk explicitly via the allowed-merchants list and per-tx limit. Phase 1.7 adds [Privacy.com](https://privacy.com) single-use virtual cards as an optional rail to isolate liability without requiring Stripe Issuing or a new protocol.

## Status

This is an active build. Phase 0–1.5 merged. Phase 1.6 (multi-step purchase via Computer Use) is being assembled by an autonomous cron routine and a local user verification step. See open issues for current bot-blocked items.

## License

MIT (planned; not yet attached).

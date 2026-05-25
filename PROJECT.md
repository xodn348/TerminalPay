# Termpay — PROJECT.md

> Single source of truth. If the code disagrees with this document, the code is wrong.

Status: **early version — self-hosted single user, terminal UI**

---

## 1. Purpose

Let AI agents pay autonomously with the user's credit card — within limits the user controls.

Distributed as a single Node.js binary that exposes both a CLI and a Model Context Protocol (MCP) server. Humans interact through a terminal UI (Ink) and `termpay setup`. Agents (Claude Code, Codex, Cursor, any MCP-aware client) invoke `termpay-mcp` tools to request payments and monitor orders. For multi-step merchants (Amazon, Etsy, etc.), termpay internally orchestrates Anthropic Computer Use — the agent calls one `purchase` tool, termpay drives the browser end-to-end and fills the card at the checkout moment.

---

## 2. Personas

- **User** — registers their card once and grants spending authority to their own agents through the terminal UI.
- **Agent** — calls `termpay pay ...` with its API key.
- **Merchant** — receives a normal card charge through a headless browser; unaware of Termpay's existence.

---

## 3. Core user stories

- **US-1.** The user adds a card once through `termpay setup` (encrypted via macOS Keychain), then sets monthly + per-tx limits and an allowed-merchants list.
- **US-2.** The user runs `termpay mcp install` once to register the MCP server with Claude Code, Codex, and Cursor.
- **US-3 (single-page billing).** The user tells Claude Code "Anthropic 크레딧 $20 충전". Claude calls `termpay.pay({merchant:"console.anthropic.com", amount:20, reason:"top-up", key:"..."})`. termpay runs policy, drives `patchright` against the merchant's billing page, fills card, returns receipt.
- **US-4 (multi-step purchase).** The user says "Amazon에서 이 URL 사줘". Claude calls `termpay.purchase({intent, merchant:"amazon.com", max_amount:15, reason, key})`. termpay launches local Patchright with the user's stored cookies, drives the checkout via Anthropic Computer Use, intercepts at the payment page to fill the card directly (card never enters the LLM context), reads the order number, returns it. Claude polls `purchase_status(id)` for progress.
- **US-5 (monitor).** "내가 산 거 보여줘" → Claude calls `termpay.orders()` + Gmail MCP for shipping email augmentation; renders payments + orders + tracking in one view.
- **US-6 (emergency stop).** `termpay.kill()` or one keystroke in `termpay ui` halts all in-flight purchases and blocks new ones within 1 second.

---

## 4. Non-goals (explicitly excluded from v1)

- ❌ Multi-user / signup / login — single user, single card, single machine
- ❌ Hosted SaaS / cloud component — PCI burden and trust requirement out of scope for solo bootstrap
- ❌ Email or push HITL — limits + allowed-merchants + kill switch are the only controls
- ❌ Card issuing / crypto / ACH / multi-currency
- ❌ OAuth / refresh tokens — Bearer API key
- ❌ Korean PG (Coupang, Naver, Toss, KCP, INICIS) — `휴대폰 본인인증` + bank-app push approval breaks the autonomous model. Deferred to v3+ as a separate track.
- ❌ Browser extension / GUI desktop app — terminal UI only
- ❌ New payment protocol — termpay is a router on top of existing rails (Patchright, Computer Use, future Privacy.com / Stripe Issuing / ACP), not a new protocol

---

## 5. Architecture (three boxes)

```
┌─────────────────────────────────────────────────────────────────┐
│  AGENT      Claude Code · Codex · Cursor · any MCP client       │
│                       │                                         │
│                       │  MCP stdio                              │
│                       ▼                                         │
│  TERMPAY    Local Node process — single MCP server              │
│                       │                                         │
│             ┌─────────┴──────────┐                              │
│             │  Tools (9 total):  │                              │
│             │   pay              │  single-page billing         │
│             │   purchase         │  multi-step (Computer Use)   │
│             │   purchase_status  │  async progress poll         │
│             │   request_card     │  external orchestrator hand  │
│             │   confirm          │  external orchestrator end   │
│             │   policy           │  limits + budget             │
│             │   payments         │  history                     │
│             │   orders           │  shipping (+Gmail MCP)       │
│             │   kill             │  emergency stop              │
│             └────────────────────┘                              │
│                       │                                         │
│  RAIL                 ▼  router by merchant + amount + risk     │
│   ├─ patchright            single-page (Anthropic Console etc)  │
│   ├─ computer_use          Anthropic Computer Use (multi-step)  │
│   ├─ operator              OpenAI Operator (stub, v1.7)         │
│   ├─ merchant_api          Vercel / Fly / Cloudflare direct API │
│   └─ privacy_com           single-use virtual card (v1.7)       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                       │
                       ├── ~/.termpay/db.sqlite     (state)
                       ├── ~/.termpay/cookies/      (per-merchant, AES-encrypted)
                       └── macOS Keychain           (vault key)
```

The agent never sees raw card data. For multi-step merchants, the Computer Use LLM
drives the browser up to the payment page, signals "checkout reached", and termpay
fills the card directly via Patchright's DOM API — card stays in the termpay process.

---

## 6. Tech stack (locked)

| Layer | Choice |
|---|---|
| Runtime | Node.js 22.5+ (uses `node:sqlite` builtin) |
| CLI parsing | `commander` |
| Terminal UI | `ink` + `react` |
| DB | SQLite via `node:sqlite` at `~/.termpay/db.sqlite` |
| Vault | `node:crypto` AES-256-GCM, key held in the OS keychain |
| Checkout | `patchright` headless Chromium (stealth Playwright fork) |
| Language | TypeScript, run via `tsx` (no build step required) |
| Package manager | `pnpm` |

---

## 7. Inviolable principles

1. **User has the last word** — kill switch effective within one second; the policy check that blocks a killed agent must run before any network call to a merchant.
2. **Every payment carries a `reason`** — requests without one are rejected at the CLI parser, before policy.
3. **CVV never persists** — the encrypted vault holds only PAN, expiry, and cardholder name. CVV is supplied per charge from an environment variable or an interactive prompt. No CVV string may appear in a process core dump after `pay` exits; the `pay` process lifetime must not exceed 30 seconds. (See §11.)
4. **PROJECT.md is the truth** — new features land in this file before the code.

---

## 8. Data model

```sql
CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),  -- single user
  encrypted_card BLOB,        -- AES-256-GCM payload: { pan, exp_month, exp_year, name }
  card_last4 TEXT,            -- plaintext last-4 for display only
  card_brand TEXT,            -- "visa" | "mastercard" | "amex" | "discover"
  card_exp TEXT,              -- plaintext "MM/YY" for display only
  vault_key_id TEXT,          -- keychain entry name we read the AES key from
  created_at INTEGER
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  api_key_hash TEXT NOT NULL,
  monthly_limit_cents INTEGER NOT NULL,
  per_tx_limit_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'killed'
  created_at INTEGER NOT NULL
);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  amount_cents INTEGER NOT NULL,
  merchant TEXT NOT NULL,           -- e.g. "openai.com"
  merchant_url TEXT,                -- exact checkout URL used
  reason TEXT NOT NULL,
  status TEXT NOT NULL,             -- 'pending' | 'succeeded' | 'failed' | 'denied' | 'unknown'
  evidence TEXT,                    -- receipt text, order id, or screenshot path
  idempotency_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (agent_id, idempotency_key)
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  agent_id TEXT,
  payment_id TEXT,
  payload_json TEXT
);
```

---

## 9. Commands and tools

### CLI subcommands (human-facing)

```
termpay setup                          # one-time card + limits + allowed merchants
termpay mcp install                    # register with Claude Code / Codex / Cursor
termpay ui                             # interactive TUI dashboard
termpay agent add <name> --monthly <usd> --per-tx <usd>
termpay agent list
termpay agent kill <id>
termpay browser login <merchant>       # persist encrypted cookies for multi-step merchants
termpay payments [--limit 20]
termpay orders [--limit 20]
termpay serve --port 7402              # optional HTTP API for non-MCP agents
```

### MCP tools (agent-facing, 9 total)

| Tool | Inputs | Use when |
|---|---|---|
| `pay` | `{merchant, amount, reason, idempotency_key}` | Single-page billing top-up (Anthropic, OpenAI, Vercel, Fly, Cloudflare). Synchronous. |
| `purchase` | `{intent, merchant, max_amount, reason, idempotency_key}` | Multi-step e-commerce (Amazon, Etsy, Shopify). Asynchronous — returns `purchase_id` immediately. |
| `purchase_status` | `{purchase_id}` | Poll for progress on a `purchase`. Returns `running` / `awaiting_human` / `succeeded` / `failed`. |
| `request_card` | `{merchant, amount, reason, idempotency_key}` | External orchestrator (caller drives the browser, asks termpay for a card at checkout). |
| `confirm` | `{payment_id, order_id, evidence}` | Companion to `request_card` — record outcome. |
| `policy` | — | Current limits, spend, allowed merchants. |
| `payments` | `{limit?}` | Recent payments with status and evidence. |
| `orders` | `{limit?}` | Orders joined with payments + shipping (Gmail MCP augmentation if connected). |
| `kill` | `{reason?}` | Emergency stop — denies new charges and aborts in-flight `purchase` within 1 s. |

### Environment

- `TERMPAY_API_KEY` — Bearer token for the calling agent (issued by `termpay agent add`)
- `TERMPAY_CARD_CVV` — CVV for the current session (alternative: stdin prompt). Legacy alias `AGENTWALLET_CARD_CVV` is also accepted.
- `ANTHROPIC_API_KEY` — required for `purchase` (Computer Use driver). termpay never logs or transmits this beyond Anthropic Messages API calls.
- `TERMPAY_VAULT_KEY` — hex AES key fallback when macOS Keychain is unavailable (Linux, CI)

CVV is wiped from process state after the merchant returns an authorization decision; the `pay` process lifetime must not exceed 30 seconds.

---

## 10. Build phases

| Phase | Work | Status |
|---|---|---|
| **0. Scaffold** | package.json, tsconfig, `lib/policy.ts` + `lib/types.ts` + `lib/agent-keys.ts`, `lib/db.ts` schema, `lib/vault.ts` AES-256-GCM. | ✅ merged (PR #9, #10) |
| **1. CLI + TUI shell** | `termpay setup`, `termpay agent ...`, `termpay ui` with Ink. Checkout stub. | ✅ merged (PR #11) |
| **2. Policy + pay command** | `termpay pay` wires policy, vault decrypt, payments row. | ✅ merged (PR #12) |
| **3. patchright checkout** | `lib/checkout.ts` fills card on `console.anthropic.com`. **G1 = real $5 charge** verifies the architecture. | ✅ scaffolding merged (PR #13); G1 local verification pending |
| **1.5. MCP wrapper + 6 tools** | `bin/mcp-server.ts`, `termpay mcp install`, `allowed_merchants` whitelist, `orders` table, `agent_name`. | ✅ merged (PR #18) |
| **1.6. Computer Use orchestration** | `purchase` + `purchase_status` MCP tools, `lib/drivers/anthropic_computer_use.ts`, `browser_login` + encrypted cookie persistence, async progress reporting. **This unlocks multi-step merchants (Amazon, Etsy).** | ✅ merged (PRs #22–#26) |
| **1.7. Plug-in rails** | `lib/drivers/openai_operator.ts` (stub until Operator API public), `lib/rails/privacy.ts` (single-use virtual card for liability isolation), `lib/rails/merchant_api.ts` (Vercel, Fly, Cloudflare direct). | ⬜ planned |
| **2. Hardening** | 3DS fallback through the TUI, retry / idempotency edges, ASCII receipt rendering, per-merchant adapter library expansion. | ⬜ planned |

See `ROADMAP.md` for validation gates and risk register.

---

## 11. Payment card data constraints

The user's own card on the user's own machine is the simplest case, but the rules from PCI DSS still shape the design:

- **PAN + expiry + cardholder name** — may be stored if encrypted. We use AES-256-GCM with a key held in the OS keychain (`security` on macOS, `secret-tool` on Linux); the database holds only the ciphertext.
- **CVV / CVC** — never stored on disk, never held in memory longer than one authorization. Captured per charge.
- **Track data, PIN** — never seen, never stored.

This is a personal-use tool today; the same architecture would survive a payments-attorney review for a future public version without a rewrite.

---

## 12. Open decisions

See `ROADMAP.md` §5 for the live list. High-impact:

- **GitHub repo rename.** `xodn348/agentwallet` → `xodn348/termpay`. Deferred until after G1 passes locally.
- **Distribution channel.** npm public publish vs Homebrew tap vs both. Decide after Phase 1.6 ships.
- **OpenAI Operator integration.** API not yet public. Stub interface in 1.7; real implementation when Operator opens to non-Plus users.

## 13. Driver orchestration (Phase 1.6)

The Computer Use driver is internal to termpay, not a separate MCP server. termpay
holds the user's `ANTHROPIC_API_KEY` and runs the Computer Use loop in its own
process. This keeps the agent-facing surface to one MCP server while letting termpay
guarantee that card data never enters the LLM context.

Flow for `purchase`:

```
Claude Code → termpay.purchase({intent, merchant, max_amount, reason, key})
              ├── policy.evaluate(merchant, max_amount)  ── deny? return immediately
              ├── INSERT purchases row (status=running)
              ├── return {purchase_id, status:"in_progress"}   ← MCP responds fast
              │
              └── (background worker)
                  ├── load encrypted cookies for merchant
                  ├── launch local Patchright with cookies
                  ├── call Anthropic Messages API with computer_20241022 tool
                  │     system prompt: "Drive checkout. When you reach a payment
                  │     page with card fields, call signal_checkout_reached and
                  │     stop. Never type the card yourself."
                  ├── loop: execute returned actions (click/type/screenshot)
                  ├── on signal_checkout_reached:
                  │     pause LLM loop
                  │     decrypt card from vault
                  │     Patchright.fill(SELECTORS.cardNumber, card.pan)        ← direct DOM
                  │     Patchright.fill(SELECTORS.cardExpiry, card.exp)
                  │     Patchright.fill(SELECTORS.cardCvc, env.TERMPAY_CARD_CVV)
                  │     wipe CVV
                  ├── resume LLM loop for "Place Order" click and confirmation
                  ├── extract order number from confirmation page text
                  └── UPDATE purchases row (status=succeeded, order_id, evidence)

Claude polls:    termpay.purchase_status({purchase_id})
                  → {status, progress, payment_id?, order_id?, evidence?}
```

Stop conditions for the background worker:

- Max amount exceeded (LLM signals or termpay detects from cart total)
- 5-minute hard timeout
- Computer Use API returns "impossible" / "needs human"
- 3DS frame detected → status `awaiting_human` (TUI prompt for OTP)
- `termpay kill` invoked → AbortController fires, browser closes within 1 s

---

## Changelog

- **2026-05-25** — Phase 1.6 complete: `purchase` + `purchase_status` MCP tools, `AnthropicComputerUseDriver` with `signal_checkout_reached` card-fill isolation, `browser login` + AES-GCM cookie persistence, `OpenaiOperatorDriver` stub, Amazon merchant adapter. All 49 tests pass.
- **2026-05-24** — Architecture lock for Phase 1.6: termpay is the single MCP entry point. The `purchase` tool internally orchestrates Anthropic Computer Use for multi-step merchants; card is filled by termpay's Patchright at the checkout moment so the LLM never sees it. Cookies persisted encrypted per merchant. Async pattern (`purchase_id` + `purchase_status` polling) avoids MCP timeout. 9 MCP tools total. Korean PG explicitly excluded until v3+.
- **2026-05-24** — Phase 1.5 merged: MCP server with 6 tools (`pay`, `policy`, `payments`, `orders`, `kill`, `record_order`), `termpay mcp install` for Claude Code / Codex / Cursor, `allowed_merchants` whitelist, `orders` table, `agent_name` on payments.
- **2026-05-24** — Phase 0-3 scaffolding merged: vault, db, types, CLI, TUI shell, pay command with policy + vault decrypt, Patchright checkout for `console.anthropic.com`. G1 (real $5 charge) verification pending on the user's local Mac.
- **2026-05-21** — Pivot to terminal UI: drop Next.js + Chrome extension + Stripe. Single Node.js binary with Ink TUI and Patchright (stealth Playwright fork) for merchant checkout. CVV never persists; `pay` process lifetime ≤ 30 s.
- Translate PROJECT.md to English; remove personal info from repo.
- Switch SQLite from `better-sqlite3` to Node 22.5+ builtin `node:sqlite`.
- Initial draft.

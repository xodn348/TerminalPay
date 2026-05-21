# AgentWallet — PROJECT.md

> Single source of truth. If the code disagrees with this document, the code is wrong.

Status: **early version — self-hosted single user, terminal UI**

---

## 1. Purpose

Let AI agents pay autonomously with the user's credit card — within limits the user controls.

Distributed as a single Node.js CLI. Humans interact through a terminal UI (Ink). Agents (Claude Code, Codex, any shell-capable assistant) invoke the same binary with subcommands.

---

## 2. Personas

- **User** — registers their card once and grants spending authority to their own agents through the terminal UI.
- **Agent** — calls `agentwallet pay ...` with its API key.
- **Merchant** — receives a normal card charge through a headless browser; unaware of AgentWallet's existence.

---

## 3. Core user stories

- **US-1.** The user adds a card once through `agentwallet setup`.
- **US-2.** The user creates an agent with monthly + per-tx limits and receives an API key (`agentwallet agent add <name>`).
- **US-3.** The agent calls `agentwallet pay --amount 500 --merchant openai.com --reason "..." --idempotency-key ...` with `AGENTWALLET_API_KEY` set.
- **US-4.** The user sees every payment with its reason in `agentwallet ui` or `agentwallet payments`.
- **US-5.** The user can instantly kill any agent (`agentwallet agent kill <id>` or one keystroke in the TUI).

---

## 4. Non-goals (explicitly excluded from this version)

- ❌ Multi-user / signup / login
- ❌ Server / cloud component
- ❌ Email or push HITL — limits + kill switch are the control
- ❌ Card issuing / crypto / ACH / multi-currency
- ❌ OAuth / refresh tokens — plain Bearer API key
- ❌ Stripe or any payment service provider
- ❌ Browser extension / GUI desktop app

---

## 5. Architecture (one binary)

```
[Claude Code / Codex / any shell]
            │
            │  shell out
            ▼
┌─────────────────────────────────────────────┐
│ agentwallet  (single Node.js binary)        │
│                                             │
│   bin/cli.ts          subcommand dispatcher │
│   bin/tui.tsx         Ink TUI (interactive) │
│                                             │
│   lib/policy.ts       limit + status check  │
│   lib/vault.ts        AES-256-GCM card box  │
│   lib/agent-keys.ts   API key issue + check │
│   lib/db.ts           SQLite store          │
│   lib/checkout.ts     Playwright purchase   │
│                                             │
└─────────────────────────────────────────────┘
            │
            ├──> SQLite at ~/.agentwallet/db.sqlite
            └──> Playwright Chromium → merchant.com checkout
```

---

## 6. Tech stack (locked)

| Layer | Choice |
|---|---|
| Runtime | Node.js 22.5+ (uses `node:sqlite` builtin) |
| CLI parsing | `commander` |
| Terminal UI | `ink` + `react` |
| DB | SQLite via `node:sqlite` at `~/.agentwallet/db.sqlite` |
| Vault | `node:crypto` AES-256-GCM, key held in the OS keychain |
| Checkout | `playwright` headless Chromium |
| Language | TypeScript, run via `tsx` (no build step required) |
| Package manager | `pnpm` |

---

## 7. Inviolable principles

1. **User has the last word** — kill switch effective within one second; the policy check that blocks a killed agent must run before any network call to a merchant.
2. **Every payment carries a `reason`** — requests without one are rejected at the CLI parser, before policy.
3. **CVV never persists** — the encrypted vault holds only PAN, expiry, and cardholder name. CVV is supplied per charge from an environment variable or an interactive prompt and is wiped from memory after the merchant returns an authorization decision. (See §11.)
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
  status TEXT NOT NULL,             -- 'succeeded' | 'failed' | 'denied'
  evidence TEXT,                    -- receipt text, order id, or screenshot path
  idempotency_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (agent_id, idempotency_key)
);
```

---

## 9. Commands

```
agentwallet setup
agentwallet ui
agentwallet agent add <name> --monthly <usd> --per-tx <usd>
agentwallet agent list
agentwallet agent kill <id>
agentwallet pay --amount <cents> --merchant <host> --reason <text>
                --idempotency-key <key> [--url <checkout_url>]
agentwallet payments [--limit 20]
```

`agentwallet pay` reads `AGENTWALLET_API_KEY` from the environment. The CVV is supplied either through `AGENTWALLET_CARD_CVV` (set by the user before invoking the agent for the session) or, in interactive use, prompted on stdin. The CVV is wiped from memory as soon as the merchant returns an authorization decision.

---

## 10. Build phases

| Phase | Work |
|---|---|
| **0. Scaffold** | package.json, tsconfig, `lib/policy.ts` + `lib/types.ts` + `lib/agent-keys.ts` ported from the previous version, new `lib/db.ts` schema, `lib/vault.ts` with AES-256-GCM. |
| **1. CLI + TUI shell** | `agentwallet setup`, `agentwallet agent ...`, `agentwallet ui` with Ink. No real charges yet — checkout step is a stub. |
| **2. Policy + pay command** | `agentwallet pay` wires policy, vault decrypt in memory, writes payments row. Still no real charge. |
| **3. Playwright checkout** | `lib/checkout.ts` fills card on real merchant page. Verified live on OpenAI billing with a $5 real charge. **This phase is the architecture gate.** |
| **4. Hardening** | 3DS prompt fallback through the TUI, Stripe Radar mitigation if needed, retry / idempotency edges, ASCII receipt rendering. |

See `ROADMAP.md` for validation gates, risk register, and naming.

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

- **Product name.** `agentwallet.ai` already exists as an unrelated paid product. A new public name is needed before any release.
- **Merchant strategy.** No whitelist in this version. Reconsider once Playwright reliability data is in.

---

## Changelog

- Pivot to terminal UI: drop Next.js + Chrome extension + MCP. Single CLI (`agentwallet`) with an interactive Ink TUI and headless subcommands. Playwright drives merchant checkout. CVV is never persisted.
- Translate PROJECT.md to English; remove personal info from repo.
- Switch SQLite from `better-sqlite3` to Node 22.5+ builtin `node:sqlite`.
- Simplify to self-hosted single user, 3 components, 4 phases.
- Initial draft.

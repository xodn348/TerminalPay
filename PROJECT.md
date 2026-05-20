# AgentWallet — PROJECT.md

> Single source of truth. If the code disagrees with this document, the code is wrong.

Status: **MVP-α — self-hosted single user**

---

## 1. Purpose

Let AI agents pay autonomously with the user's credit card — within limits the user controls.

**"Stripe for the buyer side."** MetaMask gives dApps signing power; AgentWallet gives AI agents payment power.

**MVP-α is a single-user, self-hosted tool for the developer's own Claude/Cursor.** Not a public launch.

---

## 2. Personas

- **User** — registers their card and grants spending authority to their own agents.
- **Agent** — calls the payment API with the issued API key.
- **Merchant** — receives a normal card charge; unaware of AgentWallet's existence.

---

## 3. Core user stories

- **US-1.** The user adds a card once (Stripe Elements).
- **US-2.** The user creates an agent with monthly + per-tx limits and receives an API key.
- **US-3.** The agent calls `POST /api/pay` with the API key — `reason` is required.
- **US-4.** The user sees every payment with its reason on the dashboard.
- **US-5.** The user can instantly kill any agent (kill switch).

---

## 4. Non-goals (explicitly excluded from MVP-α)

- ❌ Multi-user / signup / login
- ❌ Email HITL — limits are the control. Tighten by lowering limits.
- ❌ Card issuing / crypto / ACH / multi-currency
- ❌ Web push / browser extension
- ❌ OAuth / refresh tokens — plain Bearer API key
- ❌ Vault separation (e.g. Basis Theory) — Stripe Customer is the vault

---

## 5. Architecture (3 components)

```
[Claude/Cursor] ──MCP stdio──> [bin/mcp.ts] ──HTTP──> [Next.js localhost:3000]
                                                              │
                                                              ├──> Stripe (vault + charges)
                                                              └──> SQLite (~/.agentwallet/db.sqlite)
```

---

## 6. Tech stack (locked)

| Layer | Choice |
|---|---|
| App | Next.js 15 App Router + TypeScript |
| DB | SQLite via Node 26 builtin `node:sqlite` at `~/.agentwallet/db.sqlite` |
| Payments | Stripe (test mode, off_session PaymentIntent) |
| UI | Tailwind CSS (no shadcn) |
| Auth | **None** (localhost only). Agents use Bearer API key. |
| MCP | `bin/mcp.ts` — `@modelcontextprotocol/sdk` stdio |
| Package manager | `pnpm` |

---

## 7. Inviolable principles

1. **User has the last word** — kill switch effective within one second.
2. **Every payment carries a `reason`** — requests without one are rejected.
3. **PROJECT.md is the truth** — new features land in this file before the code.

---

## 8. Data model

```sql
CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),  -- single user = exactly one row
  stripe_customer_id TEXT,
  stripe_pm_id TEXT,
  card_last4 TEXT,
  card_brand TEXT,
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
  merchant TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,  -- 'succeeded' | 'failed' | 'denied'
  stripe_pi_id TEXT,
  idempotency_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (agent_id, idempotency_key)
);
```

---

## 9. API

```
POST /api/setup-intent          # returns Stripe SetupIntent client_secret
POST /api/cards/confirm         # persists payment method after SetupIntent succeeds
POST /api/agents                # create agent → returns API key (raw, shown once)
GET  /api/agents                # list agents
POST /api/agents/:id/kill       # kill switch
POST /api/pay                   # agent endpoint (Bearer + amount + merchant + reason + idempotency_key)
GET  /api/payments              # dashboard read
```

---

## 10. Pages

```
/                    # dashboard (card status + agents + recent payments + kill switch)
/setup               # add card (Stripe Elements)
/agents/new          # create agent form
```

---

## 11. Build phases

| Phase | Work | Parallel? |
|---|---|---|
| **0. Scaffold** | Next.js + Tailwind + SQLite schema + types + layout | ❌ single |
| **1. Card + Agent** | Lane A (card setup flow), Lane B (agent CRUD + UI) | ✅ 2 lanes |
| **2. Payment engine** | `POST /api/pay` + policy function + Stripe charge + idempotency | ❌ single (depends on A+B) |
| **3. MCP + Dashboard** | Lane C (MCP server + client SDK), Lane D (dashboard + kill switch UI) | ✅ 2 lanes |

All four phases are merged on `main`.

---

## 12. Open decisions

- **D1.** Product name / domain — `agentwallet` is the working name.
- **D2.** Merchant whitelist — none in MVP-α. Limits alone are the control. Reconsider in v2.

---

## Changelog

- Translate PROJECT.md to English; remove personal info (owner, start date) from repo per privacy policy.
- Switch SQLite from `better-sqlite3` to Node 26 builtin `node:sqlite` (zero native deps).
- Simplify to self-hosted single user, 3 components, 4 phases. Drop Basis Theory, Clerk, Resend, OAuth, browser extension.
- Initial draft.

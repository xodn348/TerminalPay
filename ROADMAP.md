# AgentWallet — ROADMAP.md

> Companion to `PROJECT.md`. PROJECT.md describes *what the system is*. This file describes *how we get there*, what we are betting on, and what would force a rethink.

---

## 1. Pivot summary

The first version of AgentWallet was scoped as a Next.js dashboard plus a Chrome extension that delivered card data into merchant checkout forms. After feasibility and legal review, that direction was retired in favor of a single terminal binary:

| | Before | After |
|---|---|---|
| Distribution | Chrome Web Store + Next.js daemon | `pnpm install -g agentwallet` |
| Human UI | React in the browser | Ink terminal UI |
| Agent interface | MCP stdio server | Plain shell subcommands |
| Card delivery | Stripe Elements iframe inside a content script | Headless Playwright fills the merchant page directly |
| CVV storage | Encrypted at rest (planned) | **Never persisted** — captured per charge, wiped after |
| Critical fragility | Stripe iframe + Native Messaging host collision | Headless-browser bot detection |

The pivot trades one fragility for another, but the new one is testable in a day and the deployment story is dramatically simpler (one `npm` package, no store reviews, no IPC).

---

## 2. Phased plan

Each phase ends with a single concrete artifact the user can run and inspect.

### Phase 0 — Scaffold (1 day)
- `package.json`: `commander`, `ink`, `react`, `playwright`, `zod`, `tsx`, `typescript`.
- `tsconfig.json` for Node 22 ESM.
- Keep from previous version: `lib/policy.ts`, `lib/types.ts`, `lib/agent-keys.ts`.
- Replace: `lib/db.ts` with the new schema in PROJECT.md §8.
- Add: `lib/vault.ts` — AES-256-GCM round-trip for `CardPlain`, key fetched from `security find-generic-password` on macOS.
- Delete: `app/`, `bin/mcp.ts`, `bin/README.md`, `lib/stripe.ts`, `lib/client-sdk.ts`, `next.config.ts`, `tailwind.config.ts`, `postcss.config.mjs`.

**Exit criterion:** `pnpm run typecheck` passes on the trimmed tree.

### Phase 1 — CLI + TUI shell (1–2 days)
- `bin/cli.ts` with Commander subcommands: `setup`, `agent add|list|kill`, `pay`, `payments`, `ui`.
- `bin/tui.tsx`: Ink screen showing card status, agent table with kill key, last 20 payments. `q` quits, `k` kills the selected agent.
- `pay` is wired but the checkout step is a stub that just records `status='succeeded'` with `evidence='STUB'`.

**Exit criterion:** the user can add a card, create an agent, run `agentwallet pay ...` from another terminal, see the row appear in the TUI within one second, and kill the agent with one keystroke.

### Phase 2 — Real policy + vault decrypt (1 day)
- `pay` reads the encrypted card, decrypts in memory only for the duration of the call, runs the policy, and produces a `CardPlain` that Phase 3 will hand to Playwright.
- CVV source: `AGENTWALLET_CARD_CVV` env var, or stdin prompt when the TTY is attached and the env var is empty.
- Idempotency: existing `UNIQUE (agent_id, idempotency_key)` is the source of truth; re-runs of the same key return the original row.

**Exit criterion:** integration test that runs `pay` twice with the same idempotency key and asserts exactly one row, two identical responses.

### Phase 3 — Playwright checkout (the gate, 2–4 days)
- `lib/checkout.ts` exposes `chargeCard(card: CardPlain, url: string, amount_cents: number): Promise<ChargeOutcome>`.
- First merchant: OpenAI billing top-up page (`platform.openai.com/account/billing`).
- Real test: $5 charge, real card, Stripe Radar live.
- 3DS handling: if Playwright detects a challenge frame, bubble it up through the TUI so the user can complete the OTP. Headless agents see `status='requires_human'`.

**Exit criterion:** §3 below — at least one real $5 charge on a real merchant succeeds end to end through `agentwallet pay`.

### Phase 4 — Hardening (1 week)
- Stripe Radar mitigation: real user agent, real screen size, stealth plugin or hand-tuned navigator overrides as needed.
- Retry policy on `network_error` (idempotent at our layer).
- ASCII receipt extraction (`evidence` column).
- macOS notification on every charge (Korean text optional per `feedback_focus_mode_inline`).

**Exit criterion:** ten consecutive real charges in a row across at least two merchants without a Playwright detection failure.

---

## 3. Validation gates

These have to clear before more code lands. If any fails, we re-open the architecture.

| # | Question | Pass condition | Owner |
|---|---|---|---|
| G1 | Can headless Playwright complete a real $5 OpenAI charge? | Charge posts; `payments.status = 'succeeded'` in DB; receipt visible in the email account. | dev |
| G2 | Does Stripe Radar block the same charge after 10 retries? | At least 8 of 10 succeed. | dev |
| G3 | Does the keychain-backed vault round-trip survive a reboot? | After reboot, `agentwallet pay` decrypts without a new prompt. | dev |
| G4 | Can the TUI kill switch beat an in-flight charge? | Kill while a Playwright session is open → the next `pay` for that agent denies before any network call. | dev |
| G5 | Does CVV memory wipe actually happen? | A heap snapshot after `pay` contains no string equal to the CVV. | dev |

G1, G2, G5 are the new ones added in this pivot.

---

## 4. Risk register

Ranked by current judgement of (impact × likelihood).

1. **Playwright detection.** Stripe Radar, Cloudflare Bot Management, Datadome. Mitigation: stealth plugin, real fingerprint, narrow whitelist of friendly merchants if needed. Trigger to reconsider: G1 fails after one full week.
2. **3DS / SCA challenges.** Many issuers force one-time-code prompts. Mitigation: TUI fallback that prompts the human. Trigger to reconsider: more than half of real charges hit a 3DS challenge.
3. **Reg E / Reg Z liability (US).** A misbehaving agent can drain the card; bank disputes may not protect the user since they delegated authority. Mitigation for now: tight per-tx and monthly limits, kill switch. Public release needs an attorney-drafted EULA.
4. **Merchant terms of service.** Many checkout pages prohibit automated access. Mitigation: this version is personal use only; no public marketing claims about supported merchants.
5. **Name collision.** `agentwallet.ai` already exists as an unrelated paid product. Mitigation: keep `agentwallet` as the npm/CLI name internally; choose a public-facing name before any release. Candidates: `LocalPay`, `autotill`, `cardproxy`, `walletd`.
6. **Korean 전자금융거래법.** Public B2C distribution from a Korean entity may require PG registration. Mitigation: do not distribute publicly from a Korean entity until checked with 율촌 / 김장 / 광장.
7. **Chromium download size.** ~300 MB on first `pnpm install`. Mitigation: document clearly; a future release can lazy-install on first `pay`.

---

## 5. Open decisions

- **D1. Public name.** Resolve before tagging a public release.
- **D2. Merchant strategy.** Open list versus curated whitelist. Decide after G1/G2.
- **D3. Linux vault backend.** `secret-tool` requires gnome-keyring; headless servers need a passphrase prompt. Decide when first Linux user appears.
- **D4. CVV interaction model.** Env var only, prompt only, or both? Current bet: both, with the prompt as fallback.
- **D5. Telemetry.** None for now. Reconsider when a second user appears.

---

## 6. What this is NOT trying to be

- Not a payment service provider. We never hold money or settle.
- Not a card issuer. We use the user's existing card.
- Not a hosted product. It runs only on the user's machine.
- Not a multi-tenant system. Single user, single card, single SQLite file.

A future v1 might revisit any of these, but each move out of this list is a deliberate decision that warrants its own design pass.

---

## 7. Pointers

- `PROJECT.md` — the locked spec.
- `~/.agentwallet/db.sqlite` — your data.
- `bin/cli.ts` — start reading the code here.

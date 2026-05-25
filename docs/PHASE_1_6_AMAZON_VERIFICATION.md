# Phase 1.6 — real-Amazon verification guide

Step-by-step for the first real `purchase` against `amazon.com`. The output is a
$5-10 order placed by Claude via the `termpay.purchase` MCP tool, with the
order number stored in the `purchases` row and a confirmation email in the
user's inbox.

This is a local-only run — the autonomous build routine cannot execute it
(no card, no Amazon login, no real browser).

## Pre-flight

```bash
cd ~/code/agentwallet
git pull
pnpm install
pnpm exec patchright install chromium
pnpm run typecheck && pnpm test    # expect: 49+/49+ pass
```

Required env:

| Variable                     | Why                                                    |
| ---------------------------- | ------------------------------------------------------ |
| `ANTHROPIC_API_KEY`          | Computer Use driver authenticates with Anthropic       |
| `TERMPAY_CARD_CVV`           | filled directly into Amazon's CVV field by Patchright  |
| `TERMPAY_COMPUTER_USE_MODEL` | (optional) `claude-sonnet-4-6` default, `claude-opus-4-7` if Sonnet stumbles |
| `TERMPAY_DRIVER`             | (optional) `mock` to dry-run without spending tokens   |

## One-time setup

```bash
# Save the card to the local vault (interactive — only you see the digits)
node --experimental-strip-types bin/cli.ts setup

# Create an agent with a $50/month, $20/tx ceiling
node --experimental-strip-types bin/cli.ts agent add g1-amazon \
  --monthly 50 --per-tx 20
# → copy the printed API key as $TERMPAY_API_KEY

# One-time merchant login. Opens visible Chromium; sign in to Amazon as usual,
# then press Enter in the terminal — cookies are encrypted to
# ~/.termpay/cookies/amazon.com.enc with the same vault key as the card.
node --experimental-strip-types bin/cli.ts browser login amazon.com
```

## Dry run (no tokens, no order)

Smoke-test the MCP shape before spending real Anthropic tokens:

```bash
TERMPAY_API_KEY=<key> TERMPAY_DRIVER=mock TERMPAY_CARD_CVV=000 \
  node --experimental-strip-types bin/mcp-server.ts
```

In another window, drive the MCP server from any MCP client (Claude Code,
Cursor, mcp-cli). Call `purchase`:

```json
{
  "intent": "buy this exact URL: https://www.amazon.com/dp/B07PZGZ8YQ",
  "merchant": "amazon.com",
  "max_amount": 15,
  "reason": "phase 1.6 dry run",
  "idempotency_key": "p16-dry-001"
}
```

Then poll `purchase_status({purchase_id})` every 1-2 s. Expected progression:

```
running → "launching browser (mock)" → "adding to cart (mock)" → succeeded
evidence: "MOCK_DRIVER"
```

## Real run — actual $5-10 order

Pick a cheap, in-stock, prime-eligible consumable so shipping is fast and
quantity equals 1. Example items in the $5-10 band:

- AmazonBasics AA batteries (4-pack)
- Post-it Notes 3-pack
- A single roll of 35mm film
- Amazon \$5 eGift Card (cheapest digital option — no shipping)

Then with the real driver:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export TERMPAY_API_KEY="<from agent add>"
export TERMPAY_CARD_CVV="<your 3-digit CVV>"
# default model is claude-sonnet-4-6 (~$0.20/purchase)
# uncomment to use Opus 4.7 for higher accuracy at ~$1.00/purchase:
# export TERMPAY_COMPUTER_USE_MODEL="claude-opus-4-7"

node --experimental-strip-types bin/mcp-server.ts
```

From the MCP client, call `purchase`:

```json
{
  "intent": "buy this exact URL: https://www.amazon.com/dp/B0XXXXXXXX (quantity 1)",
  "merchant": "amazon.com",
  "max_amount": 12,
  "reason": "phase 1.6 verification",
  "idempotency_key": "p16-real-001"
}
```

Poll `purchase_status` every 2-3 s. Expected progression:

```
running → "launching browser" → ...Computer Use driving the cart...
       → "checkout reached — filling card"
       → "model signalled completion"
status: succeeded
evidence: "ANTHROPIC_COMPUTER_USE"
```

Verify:

1. Order confirmation email arrived from Amazon.
2. Order shows up in the Amazon order history with the right item and total.
3. `purchases.payment_id` and `purchases.order_id` ideally populated (currently
   nullable — wiring those is a follow-up).
4. Spent < `max_amount`.

## When (not if) the selectors drift

`lib/merchants/amazon.ts` was authored against the Amazon checkout as of
2026-05-25. Amazon's UI changes; expect the selectors to need updates.

Symptoms:
- Purchase ends `failed` with `error: "..."` pointing at a selector
- Card-fill step times out
- LLM keeps trying to type card digits itself (rule 2 of the system prompt
  is "do NOT type card digits" — if the LLM violates it, the
  `signal_checkout_reached` selector pattern is probably wrong)

Fix loop:

1. Re-run `browser login amazon.com` if cookies expired.
2. Re-run the purchase with `TERMPAY_COMPUTER_USE_MODEL=claude-opus-4-7`
   (Opus is more robust against drift).
3. If still failing, manually walk through Amazon checkout in a regular
   browser, inspect each card field, update the selectors in
   `lib/merchants/amazon.ts`, commit with the receipt screenshot.

## Cost & rate-limit notes

- **Sonnet 4.6 budget**: roughly \$0.15-0.25 per Amazon purchase
  (~25 steps × screenshot + history). Set `TERMPAY_MAX_TOKEN_COST_USD`
  to a hard cap when that env is wired (not yet — follow-up).
- **Anthropic rate limits**: a single purchase fits well within free-tier
  message budgets but the screenshots are large; on a metered plan budget
  a few cents per attempt.

## Out of scope for this guide

- Kill-switch from the `kill` MCP tool (currently kills the **agent**, not
  individual in-flight purchases — separate follow-up)
- Multi-item carts
- Subscriptions / Subscribe & Save
- Non-US Amazon storefronts (different DOM, separate selector module)

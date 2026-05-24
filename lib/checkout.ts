import type { CardPlain, ChargeOutcome } from "./types.ts";
import { SELECTORS, detect3DS } from "./merchants/anthropic.ts";

// Keep pay process lifetime ≤ 30 s (G5). Leave 1 s for cleanup.
const CHECKOUT_TIMEOUT_MS = 29_000;

/**
 * Charge a card on the given checkout URL.
 *
 * Set TERMPAY_CHECKOUT_MOCK=1 to return a fake success without launching
 * Chromium — required for CI and cloud environments.
 *
 * CVV must be present in process.env.TERMPAY_CARD_CVV before calling;
 * the caller is responsible for wiping it after this function returns (G5).
 */
export async function chargeCard(
  card: CardPlain,
  url: string,
  amount_cents: number,
  signal: AbortSignal,
): Promise<ChargeOutcome> {
  // ── mock mode ────────────────────────────────────────────────────────────────
  if (process.env["TERMPAY_CHECKOUT_MOCK"] === "1") {
    if (signal.aborted) throw new Error("aborted");
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, 50);
      signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
    });
    return { status: "succeeded", evidence: "MOCK" };
  }

  // ── real patchright flow ──────────────────────────────────────────────────────
  const cvv = process.env["TERMPAY_CARD_CVV"] ?? "";

  // Dynamic import so patchright's Chromium download is deferred until first use.
  const { chromium } = await import("patchright");
  const browser = await chromium.launch({ headless: true });

  try {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    const page = await ctx.newPage();

    function abortCheck(): void {
      if (signal.aborted) throw new Error("aborted");
    }

    await page.goto(url, { timeout: CHECKOUT_TIMEOUT_MS });
    abortCheck();

    // Fill credit amount (dollars with two decimals)
    const dollars = (amount_cents / 100).toFixed(2);
    const amountField = page.locator(SELECTORS.creditAmountInput).first();
    if ((await amountField.count()) > 0) {
      await amountField.fill(dollars);
      abortCheck();
    }

    // Fill card details
    await page.locator(SELECTORS.cardNumberField).first().fill(card.pan);
    abortCheck();

    const expiry = `${String(card.exp_month).padStart(2, "0")}/${String(card.exp_year).slice(-2)}`;
    await page.locator(SELECTORS.cardExpiryField).first().fill(expiry);
    abortCheck();

    if (cvv) {
      await page.locator(SELECTORS.cardCvcField).first().fill(cvv);
      abortCheck();
    }

    await page.locator(SELECTORS.submitCreditButton).first().click();
    abortCheck();

    // Poll for outcome (500 ms intervals)
    const deadline = Date.now() + CHECKOUT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      abortCheck();

      const body = (await page.textContent("body")) ?? "";
      if (SELECTORS.successText.test(body)) {
        return { status: "succeeded", evidence: body.slice(0, 400) };
      }
      if (SELECTORS.errorText.test(body)) {
        return { status: "failed", evidence: body.slice(0, 400) };
      }

      const frameNames = page.frames().map((f) => f.name());
      if (detect3DS(frameNames)) {
        return { status: "requires_human", evidence: "3DS_CHALLENGE" };
      }

      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 500);
        signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
      });
    }

    return { status: "unknown" as ChargeOutcome["status"], evidence: "timeout" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "aborted") throw err; // re-throw so caller can record 'failed'
    return { status: "unknown" as ChargeOutcome["status"], evidence: msg.slice(0, 200) };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

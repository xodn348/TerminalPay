import { updatePurchase } from "../purchases.ts";
import type { BrowserDriver, DriverRunContext } from "./index.ts";

// MockDriver — simulates a multi-step purchase without launching a browser
// or calling Computer Use. Used by PR-A/B for end-to-end MCP shape verification
// and as a fallback when TERMPAY_DRIVER=mock or ANTHROPIC_API_KEY is missing.
export class MockDriver implements BrowserDriver {
  readonly name = "mock";

  run(ctx: DriverRunContext): void {
    const stages: Array<{ delayMs: number; progress: string }> = [
      { delayMs: 200, progress: "launching browser (mock)" },
      { delayMs: 500, progress: "navigating to merchant (mock)" },
      { delayMs: 700, progress: "adding to cart (mock)" },
      { delayMs: 900, progress: "reached checkout — filling card (mock)" },
    ];

    let elapsed = 0;
    for (const stage of stages) {
      elapsed += stage.delayMs;
      setTimeout(() => {
        if (ctx.signal.aborted) return;
        updatePurchase(ctx.purchase_id, { progress: stage.progress });
      }, elapsed).unref();
    }

    setTimeout(() => {
      if (ctx.signal.aborted) {
        updatePurchase(ctx.purchase_id, {
          status: "failed",
          error: "aborted",
          finished_at: Date.now(),
        });
        return;
      }
      updatePurchase(ctx.purchase_id, {
        status: "succeeded",
        progress: "order placed (mock)",
        evidence: "MOCK_DRIVER",
        finished_at: Date.now(),
      });
    }, elapsed + 300).unref();
  }
}


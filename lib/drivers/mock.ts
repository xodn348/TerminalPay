import { updatePurchase } from "../purchases.ts";

// Mock driver — simulates a multi-step purchase without launching a browser
// or calling Computer Use. Resolves to status='succeeded' after a short delay
// so PR-A can verify the async MCP shape end-to-end.
//
// Activated when:
//   - TERMPAY_DRIVER_MOCK=1 in env, OR
//   - PR-A: always (real driver lands in PR-D)
export function runMockDriver(purchase_id: string): void {
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
      updatePurchase(purchase_id, { progress: stage.progress });
    }, elapsed).unref();
  }

  setTimeout(() => {
    updatePurchase(purchase_id, {
      status: "succeeded",
      progress: "order placed (mock)",
      evidence: "MOCK_DRIVER",
      finished_at: Date.now(),
    });
  }, elapsed + 300).unref();
}

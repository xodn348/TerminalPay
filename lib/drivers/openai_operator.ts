import { updatePurchase } from "../purchases.ts";
import type { BrowserDriver, DriverRunContext } from "./index.ts";

// OpenAI Operator driver — interface-compliance stub.
//
// Activated when TERMPAY_DRIVER=openai_operator. The real implementation
// lands when the public Operator API is available; until then, marking
// purchases failed immediately is the honest behavior — better than a half-
// broken loop pretending to drive a browser.
export class OpenaiOperatorDriver implements BrowserDriver {
  readonly name = "openai_operator";

  run(ctx: DriverRunContext): void {
    updatePurchase(ctx.purchase_id, {
      status: "failed",
      error: "openai_operator_not_implemented",
      finished_at: Date.now(),
    });
  }
}

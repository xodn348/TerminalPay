// BrowserDriver — the contract every purchase driver implements.
//
// A driver is fire-and-forget: `run` returns immediately and the driver
// reports progress by calling updatePurchase(purchase_id, ...) from
// lib/purchases.ts. Callers should pass an AbortSignal so the kill switch
// (PR-D) can stop an in-flight purchase.

export interface DriverRunContext {
  purchase_id: string;
  agent_id: string;
  intent: string;
  merchant: string;
  max_amount_cents: number;
  reason: string;
  signal: AbortSignal;
}

export interface BrowserDriver {
  readonly name: string; // "mock" | "anthropic_computer_use" | "openai_operator"
  run(ctx: DriverRunContext): void;
}

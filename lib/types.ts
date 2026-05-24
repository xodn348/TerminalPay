export interface Settings {
  id: 1;
  encrypted_card: Uint8Array | null;
  card_last4: string | null;
  card_brand: string | null;
  card_exp: string | null;
  vault_key_id: string | null;
  created_at: number | null;
}

export interface Agent {
  id: string;
  name: string;
  api_key_hash: string;
  monthly_limit_cents: number;
  per_tx_limit_cents: number;
  status: "active" | "killed";
  created_at: number;
}

export interface Payment {
  id: string;
  agent_id: string;
  amount_cents: number;
  merchant: string;
  merchant_url: string | null;
  reason: string;
  status: "succeeded" | "failed" | "denied";
  evidence: string | null;
  idempotency_key: string;
  created_at: number;
}

export interface CardPlain {
  pan: string;
  exp_month: number;
  exp_year: number;
  name: string;
}

export interface ChargeOutcome {
  status: "succeeded" | "failed" | "requires_human";
  evidence: string | null;
}

export type PolicyDecision =
  | { outcome: "approve"; reasons: string[] }
  | { outcome: "deny"; reasons: string[] };

export interface PolicyInput {
  agent: Agent;
  amount_cents: number;
  monthly_spent_cents: number;
}

export interface Settings {
  id: 1;
  stripe_customer_id: string | null;
  stripe_pm_id: string | null;
  card_last4: string | null;
  card_brand: string | null;
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
  reason: string;
  status: "succeeded" | "failed" | "denied";
  stripe_pi_id: string | null;
  idempotency_key: string;
  created_at: number;
}

export type PolicyDecision =
  | { outcome: "approve"; reasons: string[] }
  | { outcome: "deny"; reasons: string[] };

export interface PolicyInput {
  agent: Agent;
  amount_cents: number;
  monthly_spent_cents: number;
}

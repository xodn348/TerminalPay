import type { CardPlain } from "./types.ts";
import { decryptCard } from "./vault.ts";
import { db } from "./db.ts";

export interface CardSource {
  ensureCard(): Promise<CardPlain>;
}

export class LocalCardSource implements CardSource {
  async ensureCard(): Promise<CardPlain> {
    const row = db
      .prepare("SELECT encrypted_card FROM settings WHERE id = 1")
      .get() as { encrypted_card: Uint8Array | null } | undefined;
    if (!row?.encrypted_card) {
      throw new Error("No card stored. Run `termpay setup` first.");
    }
    return decryptCard(row.encrypted_card);
  }
}

export class StripeIssuingSource implements CardSource {
  async ensureCard(): Promise<CardPlain> {
    throw new Error("Phase 2.5 — not implemented");
  }
}

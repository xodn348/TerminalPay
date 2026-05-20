import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getStripe } from "@/lib/stripe";
import type { Settings } from "@/lib/types";

export const runtime = "nodejs";

/**
 * Loads the single settings row (id=1), inserting it if it does not exist.
 *
 * @returns The current settings row.
 */
function loadOrCreateSettings(): Settings {
  const existing = db.prepare("SELECT * FROM settings WHERE id = 1").get();
  if (existing) return existing as unknown as Settings;
  db.prepare(
    "INSERT INTO settings (id, stripe_customer_id, stripe_pm_id, card_last4, card_brand, created_at) VALUES (1, NULL, NULL, NULL, NULL, NULL)"
  ).run();
  const inserted = db.prepare("SELECT * FROM settings WHERE id = 1").get();
  return inserted as unknown as Settings;
}

/**
 * POST /api/setup-intent
 *
 * Ensures a Stripe Customer exists for the local user, then creates an
 * off-session card SetupIntent and returns its client_secret for the
 * browser to confirm via Stripe Elements.
 *
 * @returns 200 `{ client_secret }` on success; 500 on Stripe failure.
 */
export async function POST(): Promise<NextResponse> {
  try {
    const stripe = getStripe();
    const settings = loadOrCreateSettings();

    let customerId = settings.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        description: "agentwallet local user",
      });
      customerId = customer.id;
      db.prepare(
        "UPDATE settings SET stripe_customer_id = ? WHERE id = 1"
      ).run(customerId);
    }

    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      usage: "off_session",
      payment_method_types: ["card"],
    });

    if (!setupIntent.client_secret) {
      return NextResponse.json(
        { error: "Stripe did not return a client_secret." },
        { status: 500 }
      );
    }

    return NextResponse.json({ client_secret: setupIntent.client_secret });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

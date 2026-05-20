import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getStripe } from "@/lib/stripe";

export const runtime = "nodejs";

const ConfirmBody = z.object({
  setup_intent_id: z.string().min(1),
});

/**
 * POST /api/cards/confirm
 *
 * Verifies a succeeded SetupIntent with Stripe, fetches its PaymentMethod for
 * the card brand and last4, then persists the result into the single settings
 * row.
 *
 * @param request - JSON body `{ setup_intent_id: string }`.
 * @returns 200 `{ ok: true }` on success; 400 on validation/state errors;
 *   500 on Stripe failure.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let parsed: z.infer<typeof ConfirmBody>;
  try {
    const json = (await request.json()) as unknown;
    const result = ConfirmBody.safeParse(json);
    if (!result.success) {
      return NextResponse.json(
        { error: "Invalid request body.", issues: result.error.flatten() },
        { status: 400 }
      );
    }
    parsed = result.data;
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  try {
    const stripe = getStripe();
    const setupIntent = await stripe.setupIntents.retrieve(
      parsed.setup_intent_id
    );

    if (setupIntent.status !== "succeeded") {
      return NextResponse.json(
        {
          error: `SetupIntent is not succeeded (status: ${setupIntent.status}).`,
        },
        { status: 400 }
      );
    }

    const pmRef = setupIntent.payment_method;
    const pmId = typeof pmRef === "string" ? pmRef : pmRef?.id;
    if (!pmId) {
      return NextResponse.json(
        { error: "SetupIntent has no payment_method attached." },
        { status: 400 }
      );
    }

    const paymentMethod = await stripe.paymentMethods.retrieve(pmId);
    const card = paymentMethod.card;
    if (!card) {
      return NextResponse.json(
        { error: "PaymentMethod is not a card." },
        { status: 400 }
      );
    }

    db.prepare(
      "UPDATE settings SET stripe_pm_id = ?, card_last4 = ?, card_brand = ?, created_at = ? WHERE id = 1"
    ).run(pmId, card.last4, card.brand, Date.now());

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

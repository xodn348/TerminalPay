import Stripe from "stripe";

declare global {
  // Prevents multiple instances across Next.js HMR reloads in dev.
  // eslint-disable-next-line no-var
  var __agentwallet_stripe: Stripe | undefined;
}

/**
 * Returns the server-side Stripe client singleton, creating it on first call.
 * Uses the Stripe SDK default API version.
 *
 * @returns The shared Stripe instance.
 * @throws {Error} when `STRIPE_SECRET_KEY` is not set in the environment.
 */
export function getStripe(): Stripe {
  if (globalThis.__agentwallet_stripe) return globalThis.__agentwallet_stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error(
      "STRIPE_SECRET_KEY is not set. Add it to .env.local before using Stripe."
    );
  }
  const instance = new Stripe(key);
  globalThis.__agentwallet_stripe = instance;
  return instance;
}

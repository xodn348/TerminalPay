"use client";

import * as React from "react";
import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";

/**
 * Loads the Stripe.js singleton from the publishable key env var.
 *
 * @returns A promise resolving to the Stripe.js client, or null if the
 *   publishable key is missing.
 */
function getStripePromise(): Promise<Stripe | null> {
  const key = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  if (!key) return Promise.resolve(null);
  return loadStripe(key);
}

interface SetupIntentResponse {
  client_secret?: string;
  error?: string;
}

interface ConfirmResponse {
  ok?: boolean;
  error?: string;
}

/**
 * Posts a setup_intent_id to /api/cards/confirm and returns the JSON body.
 *
 * @param setupIntentId - The succeeded SetupIntent id from Stripe.
 * @returns Parsed confirm response.
 */
async function confirmCard(setupIntentId: string): Promise<ConfirmResponse> {
  const res = await fetch("/api/cards/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ setup_intent_id: setupIntentId }),
  });
  return (await res.json()) as ConfirmResponse;
}

function CardForm({ onConfirmed }: { onConfirmed: () => void }): React.ReactElement {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!stripe || !elements) return;
    setSubmitting(true);
    setError(null);

    const result = await stripe.confirmSetup({
      elements,
      confirmParams: {
        return_url: `${window.location.origin}/setup?confirmed=1`,
      },
      redirect: "if_required",
    });

    if (result.error) {
      setError(result.error.message ?? "Unable to confirm card.");
      setSubmitting(false);
      return;
    }

    const setupIntent = result.setupIntent;
    if (!setupIntent) {
      setError("Stripe did not return a SetupIntent.");
      setSubmitting(false);
      return;
    }

    if (setupIntent.status !== "succeeded") {
      setError(`SetupIntent status: ${setupIntent.status}.`);
      setSubmitting(false);
      return;
    }

    const confirm = await confirmCard(setupIntent.id);
    if (!confirm.ok) {
      setError(confirm.error ?? "Failed to save card.");
      setSubmitting(false);
      return;
    }

    onConfirmed();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <PaymentElement />
      {error ? (
        <p className="text-sm text-red-400" role="alert">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={!stripe || !elements || submitting}
        className="w-full rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? "Saving…" : "Save card"}
      </button>
    </form>
  );
}

export default function SetupPage(): React.ReactElement {
  const router = useRouter();
  const searchParams = useSearchParams();
  const stripePromise = useMemo(() => getStripePromise(), []);

  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [returning, setReturning] = useState(false);

  // Handle 3DS redirect return: ?confirmed=1&setup_intent=seti_...
  useEffect(() => {
    if (searchParams.get("confirmed") !== "1") return;
    const setupIntentId = searchParams.get("setup_intent");
    if (!setupIntentId) {
      setLoadError("Missing setup_intent in redirect URL.");
      return;
    }
    setReturning(true);
    void (async (): Promise<void> => {
      const confirm = await confirmCard(setupIntentId);
      if (!confirm.ok) {
        setLoadError(confirm.error ?? "Failed to save card after redirect.");
        setReturning(false);
        return;
      }
      router.push("/");
    })();
  }, [searchParams, router]);

  // Fetch a SetupIntent client_secret on mount (skip during redirect flow).
  useEffect(() => {
    if (searchParams.get("confirmed") === "1") return;
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        const res = await fetch("/api/setup-intent", { method: "POST" });
        const data = (await res.json()) as SetupIntentResponse;
        if (cancelled) return;
        if (!res.ok || !data.client_secret) {
          setLoadError(data.error ?? "Failed to create SetupIntent.");
          return;
        }
        setClientSecret(data.client_secret);
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "Network error.";
        setLoadError(message);
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [searchParams]);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-6">
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-6 shadow-lg">
        <h1 className="text-xl font-semibold tracking-tight">Add a card</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Stripe stores the card. AgentWallet only stores the last 4 digits and
          brand.
        </p>

        <div className="mt-6">
          {loadError ? (
            <p className="text-sm text-red-400" role="alert">
              {loadError}
            </p>
          ) : returning ? (
            <p className="text-sm text-zinc-400">Saving card…</p>
          ) : clientSecret ? (
            <Elements
              stripe={stripePromise}
              options={{
                clientSecret,
                appearance: { theme: "night" },
              }}
            >
              <CardForm onConfirmed={() => router.push("/")} />
            </Elements>
          ) : (
            <p className="text-sm text-zinc-400">Loading…</p>
          )}
        </div>
      </div>
    </main>
  );
}

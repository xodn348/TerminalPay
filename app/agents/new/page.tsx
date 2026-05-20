"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

interface CreatedAgent {
  id: string;
  name: string;
  monthly_limit_cents: number;
  per_tx_limit_cents: number;
  status: "active" | "killed";
  created_at: number;
}

interface CreateResponse {
  agent: CreatedAgent;
  api_key: string;
}

const MAX_DOLLARS = 100_000; // matches API limit of 10,000,000 cents

function dollarsToCents(input: string): number | null {
  const n = Number.parseFloat(input);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return null;
  return Math.round(n * 100);
}

export default function NewAgentPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [monthly, setMonthly] = useState("");
  const [perTx, setPerTx] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateResponse | null>(null);
  const [copied, setCopied] = useState(false);

  function validate(): {
    name: string;
    monthly_limit_cents: number;
    per_tx_limit_cents: number;
  } | string {
    const trimmedName = name.trim();
    if (trimmedName.length < 1 || trimmedName.length > 50) {
      return "Name must be 1-50 characters.";
    }
    const monthlyCents = dollarsToCents(monthly);
    if (monthlyCents === null) return "Monthly limit must be a positive number.";
    if (monthlyCents > MAX_DOLLARS * 100) {
      return `Monthly limit must be <= $${MAX_DOLLARS.toLocaleString()}.`;
    }
    const perTxCents = dollarsToCents(perTx);
    if (perTxCents === null) {
      return "Per-transaction limit must be a positive number.";
    }
    if (perTxCents > MAX_DOLLARS * 100) {
      return `Per-transaction limit must be <= $${MAX_DOLLARS.toLocaleString()}.`;
    }
    if (perTxCents > monthlyCents) {
      return "Per-transaction limit cannot exceed the monthly limit.";
    }
    return {
      name: trimmedName,
      monthly_limit_cents: monthlyCents,
      per_tx_limit_cents: perTxCents,
    };
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError(null);
    const result = validate();
    if (typeof result === "string") {
      setError(result);
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(payload?.error ?? `Request failed (${res.status}).`);
        return;
      }
      const data = (await res.json()) as CreateResponse;
      setCreated(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSubmitting(false);
    }
  }

  async function onCopy(): Promise<void> {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.api_key);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not access clipboard. Select the key and copy manually.");
    }
  }

  if (created) {
    return (
      <main className="bg-zinc-950 text-zinc-100 min-h-screen">
        <div className="max-w-md mx-auto p-8">
          <h1 className="text-2xl font-semibold tracking-tight">
            Agent created
          </h1>
          <p className="text-sm text-zinc-400 mt-2">
            {created.agent.name}
          </p>

          <div className="mt-6 rounded-md border border-amber-700/50 bg-amber-950/40 p-4 text-sm text-amber-200">
            <p className="font-medium">This key is shown only once.</p>
            <p className="mt-1 text-amber-200/80">
              Copy it now. We store only a hash — if you lose it, create a new
              agent.
            </p>
          </div>

          <label
            htmlFor="api-key"
            className="block text-xs uppercase tracking-wide text-zinc-400 mt-6"
          >
            API key
          </label>
          <code
            id="api-key"
            className="mt-2 block break-all rounded-md border border-zinc-800 bg-zinc-900 p-3 font-mono text-sm text-zinc-100"
          >
            {created.api_key}
          </code>

          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={onCopy}
              className="flex-1 rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-white"
            >
              {copied ? "Copied" : "Copy to clipboard"}
            </button>
            <button
              type="button"
              onClick={() => router.push("/")}
              className="flex-1 rounded-md border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-100 hover:bg-zinc-900"
            >
              Done
            </button>
          </div>

          {error && (
            <p className="mt-4 text-sm text-rose-400" role="alert">
              {error}
            </p>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="bg-zinc-950 text-zinc-100 min-h-screen">
      <div className="max-w-md mx-auto p-8">
        <h1 className="text-2xl font-semibold tracking-tight">New agent</h1>
        <p className="text-sm text-zinc-400 mt-2">
          Give the agent a name and spending limits. You will get a Bearer API
          key on the next screen.
        </p>

        <form onSubmit={onSubmit} className="mt-6 space-y-5" noValidate>
          <div>
            <label
              htmlFor="name"
              className="block text-sm font-medium text-zinc-200"
            >
              Name
            </label>
            <input
              id="name"
              type="text"
              required
              maxLength={50}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="cursor-prod"
              className="mt-1 block w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-zinc-500 focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="monthly"
              className="block text-sm font-medium text-zinc-200"
            >
              Monthly limit (USD)
            </label>
            <input
              id="monthly"
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0.01"
              required
              value={monthly}
              onChange={(e) => setMonthly(e.target.value)}
              placeholder="100.00"
              className="mt-1 block w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-zinc-500 focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="per-tx"
              className="block text-sm font-medium text-zinc-200"
            >
              Per-transaction limit (USD)
            </label>
            <input
              id="per-tx"
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0.01"
              required
              value={perTx}
              onChange={(e) => setPerTx(e.target.value)}
              placeholder="20.00"
              className="mt-1 block w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-zinc-500 focus:outline-none"
            />
            <p className="mt-1 text-xs text-zinc-500">
              Must be less than or equal to the monthly limit.
            </p>
          </div>

          {error && (
            <p className="text-sm text-rose-400" role="alert">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? "Creating..." : "Create agent"}
          </button>
        </form>
      </div>
    </main>
  );
}

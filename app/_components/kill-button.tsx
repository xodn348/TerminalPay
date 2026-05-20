"use client";

import { useRouter } from "next/navigation";
import { useState, type MouseEvent } from "react";

/**
 * Confirms with the operator, POSTs to the idempotent kill endpoint, then
 * refreshes the server-rendered dashboard so the agent flips to `killed`.
 */
export function KillButton({ agentId }: { agentId: string }): React.JSX.Element {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick(_e: MouseEvent<HTMLButtonElement>): Promise<void> {
    if (pending) return;
    const ok = window.confirm(
      "Kill this agent? This stops all future payments.",
    );
    if (!ok) return;

    setError(null);
    setPending(true);
    try {
      const res = await fetch(`/api/agents/${agentId}/kill`, {
        method: "POST",
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(payload?.error ?? `Request failed (${res.status}).`);
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="bg-red-700 hover:bg-red-600 text-white text-sm px-3 py-1 rounded disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? "Killing..." : "Kill"}
      </button>
      {error && (
        <p className="text-xs text-rose-400" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

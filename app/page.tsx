import Link from "next/link";
import { db } from "@/lib/db";
import type { Agent, Payment, Settings } from "@/lib/types";
import { KillButton } from "./_components/kill-button";

export const dynamic = "force-dynamic";

const RECENT_PAYMENTS_LIMIT = 20;

/** Cents → "$X.XX" (USD, no symbol locale ambiguity). */
function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** UTC ms → "May 20, 2026". */
function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * UTC ms → "2m ago" / "1h ago" / "3d ago", falling back to a date for
 * anything older than ~30 days.
 */
function formatRelative(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return formatDate(ms);
}

/** First instant of the current UTC month, in epoch ms. */
function startOfCurrentMonthUtc(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0);
}

interface AgentWithSpend extends Agent {
  monthly_spent_cents: number;
}

function loadDashboardData(): {
  settings: Settings | null;
  agents: AgentWithSpend[];
  payments: Payment[];
} {
  const settings = (db
    .prepare(`SELECT * FROM settings WHERE id = 1`)
    .get() as unknown as Settings | undefined) ?? null;

  const agents = db
    .prepare(`SELECT * FROM agents ORDER BY created_at DESC`)
    .all() as unknown as Agent[];

  const monthStart = startOfCurrentMonthUtc(Date.now());
  const spendRows = db
    .prepare(
      `SELECT agent_id, COALESCE(SUM(amount_cents), 0) AS spent
         FROM payments
        WHERE status = 'succeeded' AND created_at >= ?
     GROUP BY agent_id`,
    )
    .all(monthStart) as { agent_id: string; spent: number }[];
  const spendByAgent = new Map<string, number>();
  for (const row of spendRows) spendByAgent.set(row.agent_id, row.spent);

  const agentsWithSpend: AgentWithSpend[] = agents.map((a) => ({
    ...a,
    monthly_spent_cents: spendByAgent.get(a.id) ?? 0,
  }));

  const payments = db
    .prepare(
      `SELECT id, agent_id, amount_cents, merchant, reason, status,
              stripe_pi_id, idempotency_key, created_at
         FROM payments
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .all(RECENT_PAYMENTS_LIMIT) as unknown as Payment[];

  return { settings, agents: agentsWithSpend, payments };
}

function StatusPill({ status }: { status: Agent["status"] }): React.JSX.Element {
  const cls =
    status === "active"
      ? "bg-emerald-900/40 text-emerald-300 border border-emerald-800"
      : "bg-rose-900/30 text-rose-300/70 border border-rose-900";
  return (
    <span className={`text-xs px-2 py-0.5 rounded ${cls}`}>{status}</span>
  );
}

function PaymentStatusPill({
  status,
}: {
  status: Payment["status"];
}): React.JSX.Element {
  const cls =
    status === "succeeded"
      ? "bg-emerald-900/40 text-emerald-300 border border-emerald-800"
      : status === "denied"
        ? "bg-amber-900/40 text-amber-300 border border-amber-800"
        : "bg-rose-900/40 text-rose-300 border border-rose-800";
  return (
    <span className={`text-xs px-2 py-0.5 rounded ${cls}`}>{status}</span>
  );
}

function CardStatusCard({
  settings,
}: {
  settings: Settings | null;
}): React.JSX.Element {
  const hasCard = !!(settings && settings.stripe_pm_id);
  if (!hasCard) {
    return (
      <div className="border border-zinc-800 rounded-lg p-4 flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">No card on file</p>
          <p className="text-xs text-zinc-500 mt-1">
            Add a card to let your agents charge it.
          </p>
        </div>
        <Link
          href="/setup"
          className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-white"
        >
          Add card
        </Link>
      </div>
    );
  }

  const brand = settings?.card_brand ?? "card";
  const last4 = settings?.card_last4 ?? "????";
  const added = settings?.created_at
    ? formatDate(settings.created_at)
    : null;
  return (
    <div className="border border-zinc-800 rounded-lg p-4">
      <p className="text-sm font-medium capitalize">
        {brand} ending in {last4}
      </p>
      {added && (
        <p className="text-xs text-zinc-500 mt-1">Added {added}</p>
      )}
    </div>
  );
}

function AgentCard({ agent }: { agent: AgentWithSpend }): React.JSX.Element {
  return (
    <div className="border border-zinc-800 rounded-lg p-4 flex items-start justify-between gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="font-semibold truncate">{agent.name}</p>
          <StatusPill status={agent.status} />
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-zinc-400">
          <div className="flex justify-between">
            <dt>Monthly limit</dt>
            <dd className="text-zinc-200">
              {formatCents(agent.monthly_limit_cents)}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt>Per-tx limit</dt>
            <dd className="text-zinc-200">
              {formatCents(agent.per_tx_limit_cents)}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt>This month</dt>
            <dd className="text-zinc-200">
              {formatCents(agent.monthly_spent_cents)} of{" "}
              {formatCents(agent.monthly_limit_cents)}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt>Created</dt>
            <dd className="text-zinc-200">{formatDate(agent.created_at)}</dd>
          </div>
        </dl>
      </div>
      {agent.status === "active" && <KillButton agentId={agent.id} />}
    </div>
  );
}

function PaymentRow({
  payment,
  agentName,
  now,
}: {
  payment: Payment;
  agentName: string;
  now: number;
}): React.JSX.Element {
  return (
    <div className="border border-zinc-800 rounded-lg p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <PaymentStatusPill status={payment.status} />
          <span className="text-sm font-medium">
            {formatCents(payment.amount_cents)}
          </span>
          <span className="text-sm text-zinc-300 truncate">
            {payment.merchant}
          </span>
        </div>
        <div className="text-xs text-zinc-500 shrink-0">
          {formatRelative(payment.created_at, now)}
        </div>
      </div>
      <div className="mt-1 flex items-center gap-2 text-xs text-zinc-500">
        <span>{agentName}</span>
      </div>
      <p className="mt-2 text-sm text-zinc-400 italic">{payment.reason}</p>
    </div>
  );
}

function EmptyState({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="border border-dashed border-zinc-800 rounded-lg p-6 text-center text-sm text-zinc-500">
      {children}
    </div>
  );
}

export default function Home(): React.JSX.Element {
  const { settings, agents, payments } = loadDashboardData();
  const agentNameById = new Map<string, string>();
  for (const a of agents) agentNameById.set(a.id, a.name);
  const now = Date.now();

  return (
    <main className="max-w-3xl mx-auto p-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">AgentWallet</h1>
        <p className="text-zinc-400 mt-1 text-sm">
          Self-hosted single-user MVP.
        </p>
      </header>

      <section className="mt-12">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400 mb-4">
          Card
        </h2>
        <CardStatusCard settings={settings} />
      </section>

      <section className="mt-12">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">
            Agents
          </h2>
          <Link
            href="/agents/new"
            className="rounded-md border border-zinc-700 px-3 py-1 text-sm text-zinc-100 hover:bg-zinc-900"
          >
            New agent
          </Link>
        </div>
        {agents.length === 0 ? (
          <EmptyState>
            No agents yet. Create one to start delegating payments.
          </EmptyState>
        ) : (
          <div className="space-y-3">
            {agents.map((agent) => (
              <AgentCard key={agent.id} agent={agent} />
            ))}
          </div>
        )}
      </section>

      <section className="mt-12">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">
            Recent payments
          </h2>
          <span className="text-xs text-zinc-500">
            (last {RECENT_PAYMENTS_LIMIT})
          </span>
        </div>
        {payments.length === 0 ? (
          <EmptyState>No payments yet.</EmptyState>
        ) : (
          <div className="space-y-3">
            {payments.map((payment) => (
              <PaymentRow
                key={payment.id}
                payment={payment}
                agentName={
                  agentNameById.get(payment.agent_id) ?? "(deleted agent)"
                }
                now={now}
              />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

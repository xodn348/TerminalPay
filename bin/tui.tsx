import { useState, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { db } from "../lib/db.ts";
import type { Agent, Payment } from "../lib/types.ts";
import { formatUSD } from "../lib/money.ts";

// ── data loading ───────────────────────────────────────────────────────────────

type DbSettings = {
  card_last4: string | null;
  card_brand: string | null;
  card_exp: string | null;
} | null;

type AppData = {
  settings: DbSettings;
  agents: Agent[];
  payments: Payment[];
  spentByAgent: Record<string, number>;
};

function loadData(): AppData {
  const settings = db
    .prepare("SELECT card_last4, card_brand, card_exp FROM settings WHERE id = 1")
    .get() as { card_last4: string | null; card_brand: string | null; card_exp: string | null } | undefined;

  const agents = db
    .prepare("SELECT * FROM agents ORDER BY created_at ASC")
    .all() as unknown as Agent[];

  const payments = db
    .prepare("SELECT * FROM payments ORDER BY created_at DESC LIMIT 20")
    .all() as unknown as Payment[];

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const spentRows = db
    .prepare(
      "SELECT agent_id, SUM(amount_cents) as spent FROM payments WHERE status = 'succeeded' AND created_at >= ? GROUP BY agent_id",
    )
    .all(monthStart) as { agent_id: string; spent: number }[];

  const spentByAgent: Record<string, number> = {};
  for (const r of spentRows) {
    spentByAgent[r.agent_id] = r.spent;
  }

  return { settings: settings ?? null, agents, payments, spentByAgent };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function makeBar(spent: number, limit: number, width = 18): string {
  const ratio = limit > 0 ? Math.min(1, spent / limit) : 0;
  const filled = Math.round(ratio * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

// ── panel names ───────────────────────────────────────────────────────────────

const PANELS = ["agents", "card", "payments"] as const;
type PanelName = (typeof PANELS)[number];

// ── sub-components ────────────────────────────────────────────────────────────

function Header({ data }: { data: AppData }) {
  const last4 = data.settings?.card_last4 ?? "----";
  const brand = data.settings?.card_brand ?? "?";
  const totalSpent = Object.values(data.spentByAgent).reduce((a, b) => a + b, 0);
  const totalLimit = data.agents.reduce((a, ag) => a + ag.monthly_limit_cents, 0);
  return (
    <Box borderStyle="single" paddingX={1}>
      <Text bold color="cyan">Termpay</Text>
      <Text>{"  │  "}Card: **** {last4} ({brand})</Text>
      <Text>{"  │  "}Month: {formatUSD(totalSpent)} / {formatUSD(totalLimit)}</Text>
    </Box>
  );
}

function AgentsPanel({
  agents,
  spentByAgent,
  active,
  selectedRow,
}: {
  agents: Agent[];
  spentByAgent: Record<string, number>;
  active: boolean;
  selectedRow: number;
}) {
  return (
    <Box
      borderStyle="round"
      borderColor={active ? "cyan" : "gray"}
      flexDirection="column"
      paddingX={1}
      minHeight={6}
    >
      <Text bold underline>Agents</Text>
      {agents.length === 0 ? (
        <Text dimColor>No agents. Run: termpay agent add</Text>
      ) : (
        agents.map((a, i) => {
          const spent = spentByAgent[a.id] ?? 0;
          const bar = makeBar(spent, a.monthly_limit_cents);
          const isSelected = active && i === selectedRow;
          const dot = a.status === "active" ? "●" : "○";
          const dotColor = a.status === "active" ? "green" : "red";
          return (
            <Box key={a.id} flexDirection="column">
              <Text bold={isSelected} color={isSelected ? "cyan" : undefined}>
                <Text color={dotColor}>{dot}</Text>
                {" "}{a.name}{a.status === "killed" ? " [killed]" : ""}
              </Text>
              <Text>
                {"  "}<Text color="yellow">{bar}</Text>
                {"  "}{formatUSD(spent)}/{formatUSD(a.monthly_limit_cents)}
              </Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}

function CardPanel({ settings, active }: { settings: DbSettings; active: boolean }) {
  return (
    <Box
      borderStyle="round"
      borderColor={active ? "cyan" : "gray"}
      flexDirection="column"
      paddingX={1}
      minHeight={5}
    >
      <Text bold underline>Card</Text>
      {settings?.card_last4 ? (
        <>
          <Text>**** **** **** {settings.card_last4}</Text>
          <Text>
            {settings.card_brand?.toUpperCase() ?? "?"}{"  "}{settings.card_exp ?? ""}
          </Text>
        </>
      ) : (
        <Text dimColor>No card. Run: termpay setup</Text>
      )}
    </Box>
  );
}

function PaymentsPanel({
  payments,
  active,
  selectedRow,
}: {
  payments: Payment[];
  active: boolean;
  selectedRow: number;
}) {
  return (
    <Box
      borderStyle="round"
      borderColor={active ? "cyan" : "gray"}
      flexDirection="column"
      paddingX={1}
      flexGrow={1}
    >
      <Text bold underline>{"Payments (last 20)"}</Text>
      {payments.length === 0 ? (
        <Text dimColor>No payments yet.</Text>
      ) : (
        payments.map((p, i) => {
          const isSelected = active && i === selectedRow;
          const statusColor =
            p.status === "succeeded" ? "green" :
            p.status === "failed"    ? "red" :
            p.status === "denied"    ? "yellow" :
            p.status === "pending"   ? "blue" :
            "gray";
          return (
            <Box key={p.id}>
              <Text bold={isSelected} color={isSelected ? "cyan" : undefined}>
                <Text color={statusColor}>{p.status.padEnd(10)}</Text>
                {" "}{p.merchant.slice(0, 28).padEnd(28)}{" "}
                {formatUSD(p.amount_cents).padEnd(8)}{" "}
                <Text dimColor>{p.reason.slice(0, 18)}</Text>
              </Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}

function KillModal({ agent }: { agent: { id: string; name: string } }) {
  return (
    <Box borderStyle="double" borderColor="red" paddingX={2} paddingY={1}>
      <Text>
        <Text color="red" bold>Kill agent "{agent.name}"? </Text>
        Press <Text bold>k</Text> to confirm, <Text bold>Esc</Text> to cancel
      </Text>
    </Box>
  );
}

function HintBar() {
  return (
    <Box borderStyle="single" paddingX={1}>
      <Text dimColor>[Tab] panel  [↑↓] select  [k] kill  [q] quit</Text>
    </Box>
  );
}

// ── main app ──────────────────────────────────────────────────────────────────

export function TuiApp() {
  const { exit } = useApp();
  const [data, setData] = useState<AppData>(loadData);
  const [activePanel, setActivePanel] = useState<PanelName>("agents");
  const [selectedRow, setSelectedRow] = useState(0);
  const [killConfirm, setKillConfirm] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setData(loadData()), 1000);
    return () => clearInterval(timer);
  }, []);

  useInput((input, key) => {
    // Kill-confirm modal intercepts all keys
    if (killConfirm) {
      if (input === "k") {
        db.prepare("UPDATE agents SET status = 'killed' WHERE id = ?").run(killConfirm.id);
        setKillConfirm(null);
        setData(loadData());
      } else if (key.escape) {
        setKillConfirm(null);
      }
      return;
    }

    if (input === "q") { exit(); return; }

    if (key.tab) {
      const idx = PANELS.indexOf(activePanel);
      const next = PANELS[(idx + 1) % PANELS.length];
      if (next !== undefined) setActivePanel(next);
      setSelectedRow(0);
      return;
    }

    if (key.upArrow) {
      setSelectedRow((r) => Math.max(0, r - 1));
      return;
    }

    if (key.downArrow) {
      const maxRow =
        activePanel === "agents"   ? Math.max(0, data.agents.length - 1) :
        activePanel === "payments" ? Math.max(0, data.payments.length - 1) :
        0;
      setSelectedRow((r) => Math.min(maxRow, r + 1));
      return;
    }

    if (input === "k" && activePanel === "agents" && data.agents.length > 0) {
      const agent = data.agents[selectedRow];
      if (agent?.status === "active") {
        setKillConfirm({ id: agent.id, name: agent.name });
      }
    }
  });

  return (
    <Box flexDirection="column">
      <Header data={data} />
      <Box flexDirection="row">
        <Box flexDirection="column" width="50%">
          <AgentsPanel
            agents={data.agents}
            spentByAgent={data.spentByAgent}
            active={activePanel === "agents"}
            selectedRow={selectedRow}
          />
          <CardPanel settings={data.settings} active={activePanel === "card"} />
        </Box>
        <Box flexDirection="column" width="50%">
          <PaymentsPanel
            payments={data.payments}
            active={activePanel === "payments"}
            selectedRow={selectedRow}
          />
        </Box>
      </Box>
      {killConfirm !== null && <KillModal agent={killConfirm} />}
      <HintBar />
    </Box>
  );
}

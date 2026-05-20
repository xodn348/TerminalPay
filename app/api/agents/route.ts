import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { generateApiKey } from "@/lib/agent-keys";
import type { Agent } from "@/lib/types";

const MAX_LIMIT_CENTS = 10_000_000;

const createAgentSchema = z
  .object({
    name: z.string().trim().min(1).max(50),
    monthly_limit_cents: z.number().int().min(1).max(MAX_LIMIT_CENTS),
    per_tx_limit_cents: z.number().int().min(1).max(MAX_LIMIT_CENTS),
  })
  .refine((v) => v.per_tx_limit_cents <= v.monthly_limit_cents, {
    message: "per_tx_limit_cents must be <= monthly_limit_cents",
    path: ["per_tx_limit_cents"],
  });

type AgentRow = Pick<
  Agent,
  | "id"
  | "name"
  | "monthly_limit_cents"
  | "per_tx_limit_cents"
  | "status"
  | "created_at"
>;

/**
 * `GET /api/agents` — list all agents, newest first.
 *
 * Returns `{ agents }` with the public projection (no `api_key_hash`).
 */
export async function GET(): Promise<NextResponse> {
  try {
    const agents = db
      .prepare(
        `SELECT id, name, monthly_limit_cents, per_tx_limit_cents, status, created_at
           FROM agents
          ORDER BY created_at DESC`,
      )
      .all() as AgentRow[];
    return NextResponse.json({ agents });
  } catch (err) {
    console.error("GET /api/agents failed", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

/**
 * `POST /api/agents` — create an agent and return its API key once.
 *
 * Body: `{ name, monthly_limit_cents, per_tx_limit_cents }`.
 * Validates and persists a sha256 hash of the generated key. The raw key is
 * returned in the response body and is never recoverable afterwards.
 */
export async function POST(req: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = createAgentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { name, monthly_limit_cents, per_tx_limit_cents } = parsed.data;

  try {
    const id = randomUUID();
    const { raw, hash } = generateApiKey();
    const created_at = Date.now();

    db.prepare(
      `INSERT INTO agents
         (id, name, api_key_hash, monthly_limit_cents, per_tx_limit_cents, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`,
    ).run(id, name, hash, monthly_limit_cents, per_tx_limit_cents, created_at);

    const agent: AgentRow = {
      id,
      name,
      monthly_limit_cents,
      per_tx_limit_cents,
      status: "active",
      created_at,
    };

    return NextResponse.json({ agent, api_key: raw }, { status: 201 });
  } catch (err) {
    console.error("POST /api/agents failed", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

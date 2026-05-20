import { NextResponse } from "next/server";
import { db } from "@/lib/db";

/**
 * `POST /api/agents/:id/kill` — flip an agent to `status='killed'`.
 *
 * Idempotent: killing an already-killed agent is a no-op success. Returns 404
 * only when the agent id is unknown.
 */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;

  try {
    const existing = db
      .prepare(`SELECT id FROM agents WHERE id = ?`)
      .get(id) as { id: string } | undefined;
    if (!existing) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    db.prepare(`UPDATE agents SET status = 'killed' WHERE id = ?`).run(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("POST /api/agents/[id]/kill failed", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

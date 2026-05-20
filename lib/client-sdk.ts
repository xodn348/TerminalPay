/**
 * AgentWallet client SDK.
 *
 * A small, dependency-free TypeScript wrapper around the AgentWallet HTTP API.
 * Used by `bin/mcp.ts` to forward MCP tool calls to the local Next.js server,
 * but kept MCP-agnostic so future SDKs (TS library, CLI, other agent runtimes)
 * can reuse it.
 *
 * Contract surface (kept near the top per AI-native style):
 *   - {@link AgentWalletClientOptions}
 *   - {@link PayInput}
 *   - {@link PayResult}
 *   - {@link AgentWalletClient}
 */

/**
 * Configuration for an {@link AgentWalletClient}.
 *
 * - `baseUrl`: HTTP origin of the AgentWallet Next.js server.
 *   Defaults to `http://localhost:3000` (the MVP-α self-hosted layout).
 * - `apiKey`: raw `ak_...` Bearer token issued from `/agents/new`.
 * - `fetchImpl`: optional override for the global `fetch` (mainly tests).
 */
export interface AgentWalletClientOptions {
  baseUrl?: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

/**
 * Inputs accepted by {@link AgentWalletClient.pay}. Mirrors the body schema of
 * `POST /api/pay` exactly.
 *
 * - `amount_cents`: integer >= 1, USD cents.
 * - `merchant`: 1..200 chars.
 * - `reason`: 1..1000 chars; human-meaningful audit string. Required.
 * - `idempotency_key`: 8..128 chars; dedupes retries server-side.
 */
export interface PayInput {
  amount_cents: number;
  merchant: string;
  reason: string;
  idempotency_key: string;
}

/**
 * Public projection of a payment row, matching the server's
 * `PaymentPublic` shape (no `idempotency_key`).
 */
export interface PaymentPublic {
  id: string;
  agent_id: string;
  amount_cents: number;
  merchant: string;
  reason: string;
  status: "succeeded" | "failed" | "denied";
  stripe_pi_id: string | null;
  created_at: number;
}

/**
 * Result returned by {@link AgentWalletClient.pay}.
 *
 * Note: `denied` and `failed` are *business outcomes*, not transport errors;
 * the HTTP call still succeeded with status 200. Only true network or
 * protocol failures cause `pay()` to throw.
 */
export interface PayResult {
  status: "succeeded" | "denied" | "failed";
  payment?: PaymentPublic;
  reasons?: string[];
  error_code?: string;
  error_message?: string;
}

/**
 * Result returned by {@link AgentWalletClient.listRecentPayments}.
 */
export interface ListPaymentsResult {
  payments: PaymentPublic[];
}

/**
 * Result returned by {@link AgentWalletClient.getMonthlySpentCents}.
 *
 * The agent's configured limits are intentionally NOT exposed — only the
 * spend the agent can derive from its own visible payment history.
 */
export interface MonthlySpendResult {
  current_month_spent_cents: number;
  asof: string;
}

/**
 * Thrown when the HTTP layer fails: network error, non-2xx response, or a
 * response shape we cannot parse. Business outcomes (`denied`, `failed`)
 * are NOT thrown — they come back inside {@link PayResult}.
 */
export class AgentWalletHttpError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly body?: unknown;

  constructor(args: {
    code: string;
    message: string;
    status?: number;
    retryable: boolean;
    body?: unknown;
  }) {
    super(args.message);
    this.name = "AgentWalletHttpError";
    this.code = args.code;
    this.status = args.status;
    this.retryable = args.retryable;
    this.body = args.body;
  }
}

const DEFAULT_BASE_URL = "http://localhost:3000";
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 200;

/**
 * Compute the start-of-current-month timestamp (ms since epoch) in UTC.
 *
 * Mirrors the server's monthly rollup window so a derived monthly spend on
 * the client side matches the server's policy evaluation.
 */
function startOfCurrentMonthUtc(now: Date = new Date()): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

/**
 * Thin TypeScript client for the AgentWallet HTTP API.
 *
 * @example
 * const client = new AgentWalletClient({ apiKey: process.env.AGENTWALLET_API_KEY! });
 * const result = await client.pay({
 *   amount_cents: 500,
 *   merchant: "OpenAI",
 *   reason: "GPT-4 API top-up for code-review skill",
 *   idempotency_key: crypto.randomUUID(),
 * });
 */
export class AgentWalletClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AgentWalletClientOptions) {
    if (!options.apiKey || typeof options.apiKey !== "string") {
      throw new Error("AgentWalletClient: apiKey is required");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Make a payment.
   *
   * @param input - {@link PayInput}
   * @returns {@link PayResult} — `denied`/`failed` are valid outcomes, not errors.
   * @throws {AgentWalletHttpError} on network or non-2xx HTTP errors.
   */
  async pay(input: PayInput): Promise<PayResult> {
    const url = `${this.baseUrl}/api/pay`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(input),
      });
    } catch (err) {
      throw new AgentWalletHttpError({
        code: "network_error",
        message: `fetch ${url} failed: ${(err as Error).message}`,
        retryable: true,
      });
    }

    const body = await this.readJson(res, url);

    if (!res.ok) {
      throw new AgentWalletHttpError({
        code: "http_error",
        message: `POST ${url} returned ${res.status}`,
        status: res.status,
        retryable: res.status >= 500,
        body,
      });
    }

    if (!isPayResult(body)) {
      throw new AgentWalletHttpError({
        code: "invalid_response",
        message: `POST ${url} returned an unrecognized body shape`,
        retryable: false,
        body,
      });
    }
    return body;
  }

  /**
   * Fetch the most recent payments for the local wallet.
   *
   * Note: `/api/payments` is the unauthenticated dashboard endpoint in MVP-α;
   * it returns payments across all agents on this host.
   *
   * @param opts.limit - 1..200, defaults to 20.
   * @throws {AgentWalletHttpError} on network or non-2xx HTTP errors.
   */
  async listRecentPayments(opts?: {
    limit?: number;
  }): Promise<ListPaymentsResult> {
    const limit = clampLimit(opts?.limit ?? DEFAULT_LIST_LIMIT);
    const url = `${this.baseUrl}/api/payments?limit=${limit}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: "GET" });
    } catch (err) {
      throw new AgentWalletHttpError({
        code: "network_error",
        message: `fetch ${url} failed: ${(err as Error).message}`,
        retryable: true,
      });
    }

    const body = await this.readJson(res, url);

    if (!res.ok) {
      throw new AgentWalletHttpError({
        code: "http_error",
        message: `GET ${url} returned ${res.status}`,
        status: res.status,
        retryable: res.status >= 500,
        body,
      });
    }

    if (!isListPaymentsResult(body)) {
      throw new AgentWalletHttpError({
        code: "invalid_response",
        message: `GET ${url} returned an unrecognized body shape`,
        retryable: false,
        body,
      });
    }
    return body;
  }

  /**
   * Client-side derived: sum of `amount_cents` over `succeeded` payments in
   * the current UTC month. The wallet's configured per-agent limits are NOT
   * visible to the agent and are deliberately omitted from the response.
   *
   * Pulls the most recent 200 payments — sufficient for MVP-α single-user
   * scale; the dashboard does the authoritative rollup server-side.
   */
  async getMonthlySpentCents(): Promise<MonthlySpendResult> {
    const { payments } = await this.listRecentPayments({
      limit: MAX_LIST_LIMIT,
    });
    const monthStart = startOfCurrentMonthUtc();
    let total = 0;
    for (const p of payments) {
      if (p.status === "succeeded" && p.created_at >= monthStart) {
        total += p.amount_cents;
      }
    }
    return {
      current_month_spent_cents: total,
      asof: new Date().toISOString(),
    };
  }

  /**
   * Parse a JSON body, surfacing parse failures as {@link AgentWalletHttpError}.
   * Treats an empty body as `null`.
   */
  private async readJson(res: Response, url: string): Promise<unknown> {
    const text = await res.text();
    if (text === "") return null;
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new AgentWalletHttpError({
        code: "invalid_response",
        message: `failed to parse JSON from ${url}: ${(err as Error).message}`,
        status: res.status,
        retryable: false,
        body: text,
      });
    }
  }
}

/**
 * Clamp `limit` into the server-accepted range [1, 200].
 */
function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_LIST_LIMIT;
  const n = Math.floor(limit);
  if (n < 1) return 1;
  if (n > MAX_LIST_LIMIT) return MAX_LIST_LIMIT;
  return n;
}

/**
 * Narrow `unknown` to {@link PayResult}. Tolerant on optional fields,
 * strict on `status`.
 */
function isPayResult(value: unknown): value is PayResult {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.status === "succeeded" || v.status === "denied" || v.status === "failed"
  );
}

/**
 * Narrow `unknown` to {@link ListPaymentsResult}.
 */
function isListPaymentsResult(value: unknown): value is ListPaymentsResult {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.payments);
}

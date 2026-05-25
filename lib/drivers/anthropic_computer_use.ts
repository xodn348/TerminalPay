// Anthropic Computer Use driver — drives a multi-step merchant checkout end
// to end. The LLM sees screenshots and emits mouse/keyboard actions. When it
// detects a card-entry form it calls the `signal_checkout_reached` virtual
// tool — the driver pauses the loop, fills the card via Patchright (LLM never
// sees the digits), then resumes so the LLM clicks "Place order".
//
// PR-D of the Phase 1.6 series (#19).
//
// Most of the file is the pure `driveLoop` function and small action handlers.
// Both take dependency-injected `ApiClient` and `PageLike` so tests can run
// the full loop against fakes — no real Anthropic API call, no real browser.

import Anthropic from "@anthropic-ai/sdk";
import { updatePurchase } from "../purchases.ts";
import { loadCookies } from "../cookies.ts";
import { LocalCardSource } from "../card_source.ts";
import {
  SELECTORS as AMAZON_SELECTORS,
  HOME_URL as AMAZON_HOME,
} from "../merchants/amazon.ts";
import type { BrowserDriver, DriverRunContext } from "./index.ts";
import type { CardPlain } from "../types.ts";

export const VIEWPORT_WIDTH = 1280;
export const VIEWPORT_HEIGHT = 800;
export const HARD_TIMEOUT_MS = 5 * 60 * 1000;
export const BETA_HEADER = "computer-use-2025-11-24";
export const COMPUTER_TOOL_TYPE = "computer_20251124";
export const DEFAULT_MODEL = "claude-sonnet-4-6";

// ── DI shapes ────────────────────────────────────────────────────────────────
// Narrowed shapes so tests inject fakes without booting Patchright/Anthropic.

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | {
            type: "image";
            source: { type: "base64"; media_type: "image/png"; data: string };
          }
      >;
  is_error?: boolean;
}

export interface ApiResponse {
  stop_reason: string;
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  >;
}

export interface ApiClient {
  create(params: {
    model: string;
    max_tokens: number;
    tools: unknown[];
    messages: unknown[];
    betas: string[];
  }): Promise<ApiResponse>;
}

export interface PageLike {
  screenshot(opts?: { type?: "png" }): Promise<Buffer>;
  mouse: {
    click(x: number, y: number, opts?: { button?: string }): Promise<void>;
    move(x: number, y: number): Promise<void>;
    wheel(deltaX: number, deltaY: number): Promise<void>;
  };
  keyboard: {
    type(text: string): Promise<void>;
    press(key: string): Promise<void>;
  };
  waitForTimeout(ms: number): Promise<void>;
  fill(selector: string, text: string): Promise<void>;
  selectOption(selector: string, value: string): Promise<unknown>;
  uncheck(selector: string): Promise<void>;
  click(selector: string): Promise<void>;
  textContent(selector: string): Promise<string | null>;
  isVisible(selector: string): Promise<boolean>;
}

// ── driver class ─────────────────────────────────────────────────────────────

export class AnthropicComputerUseDriver implements BrowserDriver {
  readonly name = "anthropic_computer_use";

  run(ctx: DriverRunContext): void {
    this.runAsync(ctx).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      updatePurchase(ctx.purchase_id, {
        status: "failed",
        error: msg.slice(0, 500),
        finished_at: Date.now(),
      });
    });
  }

  private async runAsync(ctx: DriverRunContext): Promise<void> {
    const apiKey = process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
    const model = process.env["TERMPAY_COMPUTER_USE_MODEL"] ?? DEFAULT_MODEL;

    const cvv = process.env["TERMPAY_CARD_CVV"] ?? "";
    if (!cvv) throw new Error("TERMPAY_CARD_CVV not set");

    updatePurchase(ctx.purchase_id, { progress: "launching browser" });

    const { chromium } = await import("patchright");
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({
      viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
    });

    const cookies = loadCookies(ctx.merchant);
    if (cookies && cookies.length > 0) {
      await context.addCookies(cookies as never);
    }

    const page = await context.newPage();
    await page.goto(merchantHome(ctx.merchant));

    const anthropic = new Anthropic({ apiKey });
    const api: ApiClient = {
      create: (params) =>
        anthropic.beta.messages.create(params as never) as unknown as Promise<ApiResponse>,
    };

    try {
      await driveLoop({
        api,
        model,
        page: page as unknown as PageLike,
        ctx,
        cardSource: new LocalCardSource(),
        cvv,
      });
    } finally {
      // Wipe CVV (G5): callers set process.env, but driver shouldn't outlive that lifetime
      await context.close();
      await browser.close();
    }
  }
}

export function merchantHome(merchant: string): string {
  if (merchant === "amazon.com" || merchant === "www.amazon.com") return AMAZON_HOME;
  return `https://${merchant}`;
}

// ── main loop ────────────────────────────────────────────────────────────────

export interface DriveLoopParams {
  api: ApiClient;
  model: string;
  page: PageLike;
  ctx: DriverRunContext;
  cardSource: { ensureCard(): Promise<CardPlain> };
  cvv: string;
  now?: () => number;
  maxIterations?: number;
}

export async function driveLoop(params: DriveLoopParams): Promise<void> {
  const { api, model, page, ctx, cardSource, cvv } = params;
  const now = params.now ?? Date.now;
  const maxIterations = params.maxIterations ?? 50;
  const startedAt = now();

  const tools = [
    {
      type: COMPUTER_TOOL_TYPE,
      name: "computer",
      display_width_px: VIEWPORT_WIDTH,
      display_height_px: VIEWPORT_HEIGHT,
    },
    {
      name: "signal_checkout_reached",
      description:
        "Call this the moment a card-entry form is visible on screen. Do NOT type any card details — " +
        "termpay will fill them. After this call, the next screenshot will show the card filled in; " +
        "then click the 'Place your order' button to complete the purchase.",
      input_schema: { type: "object", properties: {} },
    },
  ];

  const systemPrompt = buildSystemPrompt(ctx);

  const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [
    { role: "user", content: [{ type: "text", text: systemPrompt }] },
  ];

  for (let i = 0; i < maxIterations; i++) {
    if (ctx.signal.aborted) {
      updatePurchase(ctx.purchase_id, {
        status: "failed",
        error: "aborted",
        finished_at: now(),
      });
      return;
    }
    if (now() - startedAt > HARD_TIMEOUT_MS) {
      updatePurchase(ctx.purchase_id, {
        status: "failed",
        error: "timeout_5min",
        finished_at: now(),
      });
      return;
    }

    const response = await api.create({
      model,
      max_tokens: 1024,
      tools,
      messages,
      betas: [BETA_HEADER],
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      updatePurchase(ctx.purchase_id, {
        status: "succeeded",
        progress: "model signalled completion",
        evidence: "ANTHROPIC_COMPUTER_USE",
        finished_at: now(),
      });
      return;
    }

    if (response.stop_reason !== "tool_use") {
      updatePurchase(ctx.purchase_id, {
        status: "failed",
        error: `unexpected_stop_reason: ${response.stop_reason}`,
        finished_at: now(),
      });
      return;
    }

    const toolResults: ToolResultBlock[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      if (block.name === "signal_checkout_reached") {
        updatePurchase(ctx.purchase_id, {
          progress: "checkout reached — filling card",
        });
        const card = await cardSource.ensureCard();
        await fillCardForMerchant(page, ctx.merchant, card, cvv);
        const screenshot = await page.screenshot({ type: "png" });
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: screenshot.toString("base64"),
              },
            },
          ],
        });
        continue;
      }

      if (block.name === "computer") {
        try {
          const content = await executeComputerAction(page, block.input);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content,
          });
        } catch (err) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: err instanceof Error ? err.message.slice(0, 200) : "action_failed",
            is_error: true,
          });
        }
        continue;
      }

      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: `unknown tool: ${block.name}`,
        is_error: true,
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  updatePurchase(ctx.purchase_id, {
    status: "failed",
    error: `max_iterations_${maxIterations}`,
    finished_at: now(),
  });
}

// ── computer action handler ──────────────────────────────────────────────────

export type ComputerActionResult =
  | string
  | Array<
      | { type: "text"; text: string }
      | {
          type: "image";
          source: { type: "base64"; media_type: "image/png"; data: string };
        }
    >;

export async function executeComputerAction(
  page: PageLike,
  input: Record<string, unknown>,
): Promise<ComputerActionResult> {
  const action = String(input["action"] ?? "");
  const coord = input["coordinate"] as [number, number] | undefined;
  const text = input["text"] as string | undefined;
  const duration = input["duration"] as number | undefined;

  switch (action) {
    case "screenshot": {
      const buf = await page.screenshot({ type: "png" });
      return [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: buf.toString("base64"),
          },
        },
      ];
    }
    case "left_click":
    case "right_click":
    case "middle_click": {
      if (!coord) throw new Error("missing coordinate");
      const button =
        action === "right_click" ? "right" : action === "middle_click" ? "middle" : undefined;
      await page.mouse.click(coord[0], coord[1], button ? { button } : undefined);
      return "ok";
    }
    case "mouse_move": {
      if (!coord) throw new Error("missing coordinate");
      await page.mouse.move(coord[0], coord[1]);
      return "ok";
    }
    case "scroll": {
      const dy = (input["scroll_amount"] as number | undefined) ?? 3;
      const direction = String(input["scroll_direction"] ?? "down");
      const sign = direction === "up" ? -1 : 1;
      await page.mouse.wheel(0, sign * dy * 100);
      return "ok";
    }
    case "type": {
      if (typeof text !== "string") throw new Error("missing text");
      await page.keyboard.type(text);
      return "ok";
    }
    case "key": {
      if (typeof text !== "string") throw new Error("missing key text");
      await page.keyboard.press(text);
      return "ok";
    }
    case "wait": {
      const ms = (duration ?? 1) * 1000;
      await page.waitForTimeout(ms);
      return "ok";
    }
    default:
      throw new Error(`unsupported_action: ${action}`);
  }
}

// ── card fill ────────────────────────────────────────────────────────────────

export async function fillCardForMerchant(
  page: PageLike,
  merchant: string,
  card: CardPlain,
  cvv: string,
): Promise<void> {
  if (merchant === "amazon.com" || merchant === "www.amazon.com") {
    await fillAmazonCard(page, card, cvv);
    return;
  }
  throw new Error(`no card-fill flow for merchant: ${merchant}`);
}

export async function fillAmazonCard(
  page: PageLike,
  card: CardPlain,
  cvv: string,
): Promise<void> {
  // The "Use a different payment method" link may or may not be present
  // depending on whether the user has saved cards. Try clicking it; ignore
  // if absent.
  try {
    if (await page.isVisible(AMAZON_SELECTORS.useDifferentPaymentMethod)) {
      await page.click(AMAZON_SELECTORS.useDifferentPaymentMethod);
    }
  } catch {
    /* selector missing — assume we're already on the add-card form */
  }

  await page.fill(AMAZON_SELECTORS.cardNumberField, card.pan);
  await page.selectOption(
    AMAZON_SELECTORS.cardExpiryMonthSelect,
    String(card.exp_month).padStart(2, "0"),
  );
  await page.selectOption(AMAZON_SELECTORS.cardExpiryYearSelect, String(card.exp_year));
  await page.fill(AMAZON_SELECTORS.cardNameField, card.name);
  await page.fill(AMAZON_SELECTORS.cardCvvField, cvv);

  if (await page.isVisible(AMAZON_SELECTORS.saveCardCheckbox)) {
    try {
      await page.uncheck(AMAZON_SELECTORS.saveCardCheckbox);
    } catch {
      /* already unchecked or differently-shaped checkbox; ignore */
    }
  }

  await page.click(AMAZON_SELECTORS.addCardButton);
}

// ── system prompt ────────────────────────────────────────────────────────────

export function buildSystemPrompt(ctx: DriverRunContext): string {
  const maxDollars = (ctx.max_amount_cents / 100).toFixed(2);
  return [
    `You are a shopping agent driving the ${ctx.merchant} checkout flow on behalf of the user.`,
    ``,
    `The user's intent: ${ctx.intent}`,
    ``,
    `Reason: ${ctx.reason}`,
    ``,
    `RULES:`,
    `1. Maximum spend: $${maxDollars}. If the cart total exceeds this, do NOT proceed — stop and explain.`,
    `2. When you reach a card-entry form, call the \`signal_checkout_reached\` tool and STOP — do not type card digits yourself. termpay will fill the card via direct DOM access, then you'll see a screenshot with the card filled in. Click "Place your order" after that.`,
    `3. Do not save the card to the merchant's account if a "Save for future use" option appears — keep it unchecked.`,
    `4. Use the \`computer\` tool to navigate, click, type, and screenshot. Always take a screenshot first to see the current state.`,
    `5. If you encounter a CAPTCHA, 2FA prompt, or any state requiring human input, stop and explain.`,
    `6. End your turn (do not call any tool) once the order is confirmed — termpay will then mark the purchase succeeded.`,
    ``,
    `Start by taking a screenshot to see the current page.`,
  ].join("\n");
}

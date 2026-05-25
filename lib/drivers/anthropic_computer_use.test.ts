import { test } from "node:test";
import assert from "node:assert";
import { randomUUID } from "node:crypto";

process.env["TERMPAY_DB_PATH"] =
  process.env["TERMPAY_DB_PATH"] ?? `/tmp/termpay-acu-test-${randomUUID()}.sqlite`;
process.env["TERMPAY_VAULT_KEY"] =
  process.env["TERMPAY_VAULT_KEY"] ??
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import type { ApiClient, PageLike } from "./anthropic_computer_use.ts";

const { db } = await import("../db.ts");
const { createPurchase, getPurchase } = await import("../purchases.ts");
const {
  driveLoop,
  executeComputerAction,
  fillAmazonCard,
  buildSystemPrompt,
  merchantHome,
} = await import("./anthropic_computer_use.ts");

type FakePageCall = { method: string; args: unknown[] };

function makeFakePage(opts: {
  visibilityMap?: Record<string, boolean>;
  textContent?: Record<string, string>;
} = {}) {
  const calls: FakePageCall[] = [];
  const screenshot = Buffer.from("FAKEPNG");
  const visibilityMap = opts.visibilityMap ?? {};
  return {
    calls,
    page: {
      async screenshot(options?: { type?: "png" }) {
        calls.push({ method: "screenshot", args: [options] });
        return screenshot;
      },
      mouse: {
        async click(x: number, y: number, o?: { button?: string }) {
          calls.push({ method: "mouse.click", args: [x, y, o] });
        },
        async move(x: number, y: number) {
          calls.push({ method: "mouse.move", args: [x, y] });
        },
        async wheel(dx: number, dy: number) {
          calls.push({ method: "mouse.wheel", args: [dx, dy] });
        },
      },
      keyboard: {
        async type(text: string) {
          calls.push({ method: "keyboard.type", args: [text] });
        },
        async press(key: string) {
          calls.push({ method: "keyboard.press", args: [key] });
        },
      },
      async waitForTimeout(ms: number) {
        calls.push({ method: "waitForTimeout", args: [ms] });
      },
      async fill(selector: string, text: string) {
        calls.push({ method: "fill", args: [selector, text] });
      },
      async selectOption(selector: string, value: string) {
        calls.push({ method: "selectOption", args: [selector, value] });
        return [];
      },
      async uncheck(selector: string) {
        calls.push({ method: "uncheck", args: [selector] });
      },
      async click(selector: string) {
        calls.push({ method: "click", args: [selector] });
      },
      async textContent(selector: string) {
        calls.push({ method: "textContent", args: [selector] });
        return opts.textContent?.[selector] ?? null;
      },
      async isVisible(selector: string) {
        calls.push({ method: "isVisible", args: [selector] });
        return visibilityMap[selector] ?? false;
      },
    } satisfies PageLike,
  };
}

function seedAgent(): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO agents (id, name, api_key_hash, monthly_limit_cents, per_tx_limit_cents, status, created_at)
     VALUES (?, 'test', 'h', 10000, 5000, 'active', ?)`,
  ).run(id, Date.now());
  return id;
}

function freshPurchase(agent_id: string, merchant = "amazon.com") {
  return createPurchase({
    agent_id,
    agent_name: null,
    intent: "buy a $5 widget",
    merchant,
    max_amount_cents: 1000,
    reason: "test",
    idempotency_key: `k-${randomUUID()}`,
    driver: "anthropic_computer_use",
  }).purchase;
}

test("executeComputerAction maps screenshot to base64 image", async () => {
  const { page } = makeFakePage();
  const result = await executeComputerAction(page, { action: "screenshot" });
  assert.ok(Array.isArray(result));
  const block = (result as Array<{ type: string }>)[0];
  assert.equal(block?.type, "image");
});

test("executeComputerAction maps left_click to mouse.click", async () => {
  const { page, calls } = makeFakePage();
  await executeComputerAction(page, { action: "left_click", coordinate: [100, 200] });
  assert.deepEqual(calls.find((c) => c.method === "mouse.click")?.args, [100, 200, undefined]);
});

test("executeComputerAction maps right_click with button=right", async () => {
  const { page, calls } = makeFakePage();
  await executeComputerAction(page, { action: "right_click", coordinate: [50, 60] });
  const click = calls.find((c) => c.method === "mouse.click");
  assert.deepEqual(click?.args, [50, 60, { button: "right" }]);
});

test("executeComputerAction maps type to keyboard.type", async () => {
  const { page, calls } = makeFakePage();
  await executeComputerAction(page, { action: "type", text: "hello" });
  assert.deepEqual(calls.find((c) => c.method === "keyboard.type")?.args, ["hello"]);
});

test("executeComputerAction maps key to keyboard.press", async () => {
  const { page, calls } = makeFakePage();
  await executeComputerAction(page, { action: "key", text: "Return" });
  assert.deepEqual(calls.find((c) => c.method === "keyboard.press")?.args, ["Return"]);
});

test("executeComputerAction maps scroll with direction=up to negative wheel", async () => {
  const { page, calls } = makeFakePage();
  await executeComputerAction(page, {
    action: "scroll",
    scroll_direction: "up",
    scroll_amount: 5,
  });
  const wheel = calls.find((c) => c.method === "mouse.wheel");
  assert.deepEqual(wheel?.args, [0, -500]);
});

test("executeComputerAction rejects unknown action", async () => {
  const { page } = makeFakePage();
  await assert.rejects(
    () => executeComputerAction(page, { action: "fly_to_moon" }),
    /unsupported_action: fly_to_moon/,
  );
});

test("executeComputerAction rejects missing coordinate", async () => {
  const { page } = makeFakePage();
  await assert.rejects(
    () => executeComputerAction(page, { action: "left_click" }),
    /missing coordinate/,
  );
});

test("fillAmazonCard fills all card fields and skips save-card when not visible", async () => {
  const { page, calls } = makeFakePage({
    visibilityMap: { /* nothing visible */ },
  });
  await fillAmazonCard(
    page,
    { pan: "4242424242424242", exp_month: 5, exp_year: 2030, name: "Test User" },
    "123",
  );
  const fills = calls.filter((c) => c.method === "fill");
  // card number, name, cvv = 3 fills
  assert.equal(fills.length, 3);
  assert.ok(fills.some((f) => f.args[1] === "4242424242424242"));
  assert.ok(fills.some((f) => f.args[1] === "Test User"));
  assert.ok(fills.some((f) => f.args[1] === "123"));

  const selects = calls.filter((c) => c.method === "selectOption");
  assert.equal(selects.length, 2); // month + year
  assert.ok(selects.some((s) => s.args[1] === "05"));
  assert.ok(selects.some((s) => s.args[1] === "2030"));

  // save-card not visible → no uncheck call
  assert.equal(calls.filter((c) => c.method === "uncheck").length, 0);
});

test("fillAmazonCard unchecks save-card when visible", async () => {
  const { page, calls } = makeFakePage({
    visibilityMap: { 'input[type="checkbox"][name*="save"], input#saveCard': true },
  });
  await fillAmazonCard(
    page,
    { pan: "4242", exp_month: 1, exp_year: 2030, name: "x" },
    "1",
  );
  assert.ok(calls.some((c) => c.method === "uncheck"));
});

test("buildSystemPrompt mentions max amount, merchant, and signal_checkout_reached", () => {
  const prompt = buildSystemPrompt({
    purchase_id: "p1",
    agent_id: "a1",
    intent: "buy widget",
    merchant: "amazon.com",
    max_amount_cents: 750,
    reason: "test",
    signal: new AbortController().signal,
  });
  assert.match(prompt, /\$7\.50/);
  assert.match(prompt, /amazon\.com/);
  assert.match(prompt, /signal_checkout_reached/);
  assert.match(prompt, /buy widget/);
});

test("merchantHome rewrites amazon.com to HOME_URL", () => {
  assert.equal(merchantHome("amazon.com"), "https://www.amazon.com");
  assert.equal(merchantHome("www.amazon.com"), "https://www.amazon.com");
  assert.equal(merchantHome("etsy.com"), "https://etsy.com");
});

test("driveLoop: model end_turn → purchase succeeded", async () => {
  const agent_id = seedAgent();
  const purchase = freshPurchase(agent_id);
  const { page } = makeFakePage();

  const api: ApiClient = {
    create: async () => ({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Order placed." }],
    }),
  };

  await driveLoop({
    api,
    model: "claude-sonnet-4-6",
    page,
    ctx: {
      purchase_id: purchase.id,
      agent_id,
      intent: "x",
      merchant: "amazon.com",
      max_amount_cents: 500,
      reason: "r",
      signal: new AbortController().signal,
    },
    cardSource: { ensureCard: async () => ({ pan: "x", exp_month: 1, exp_year: 2030, name: "x" }) },
    cvv: "123",
  });

  const final = getPurchase(purchase.id);
  assert.equal(final?.status, "succeeded");
  assert.equal(final?.evidence, "ANTHROPIC_COMPUTER_USE");
});

test("driveLoop: aborted ctx → purchase failed with error=aborted", async () => {
  const agent_id = seedAgent();
  const purchase = freshPurchase(agent_id);
  const { page } = makeFakePage();

  const controller = new AbortController();
  controller.abort();

  const api: ApiClient = {
    create: async () => {
      throw new Error("should not be called when already aborted");
    },
  };

  await driveLoop({
    api,
    model: "claude-sonnet-4-6",
    page,
    ctx: {
      purchase_id: purchase.id,
      agent_id,
      intent: "x",
      merchant: "amazon.com",
      max_amount_cents: 500,
      reason: "r",
      signal: controller.signal,
    },
    cardSource: { ensureCard: async () => ({ pan: "x", exp_month: 1, exp_year: 2030, name: "x" }) },
    cvv: "123",
  });

  const final = getPurchase(purchase.id);
  assert.equal(final?.status, "failed");
  assert.equal(final?.error, "aborted");
});

test("driveLoop: signal_checkout_reached pauses, fills card, resumes, succeeds", async () => {
  const agent_id = seedAgent();
  const purchase = freshPurchase(agent_id);
  const { page, calls } = makeFakePage();

  let step = 0;
  const api: ApiClient = {
    create: async () => {
      step++;
      if (step === 1) {
        return {
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "tu_1",
              name: "signal_checkout_reached",
              input: {},
            },
          ],
        };
      }
      return { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] };
    },
  };

  await driveLoop({
    api,
    model: "claude-sonnet-4-6",
    page,
    ctx: {
      purchase_id: purchase.id,
      agent_id,
      intent: "x",
      merchant: "amazon.com",
      max_amount_cents: 500,
      reason: "r",
      signal: new AbortController().signal,
    },
    cardSource: {
      ensureCard: async () => ({
        pan: "4242424242424242",
        exp_month: 6,
        exp_year: 2030,
        name: "Test User",
      }),
    },
    cvv: "999",
  });

  const final = getPurchase(purchase.id);
  assert.equal(final?.status, "succeeded");

  // Card fill happened on page
  assert.ok(calls.some((c) => c.method === "fill" && c.args[1] === "4242424242424242"));
  assert.ok(calls.some((c) => c.method === "fill" && c.args[1] === "999"));
});

test("driveLoop: max iterations exceeded → failed with max_iterations_*", async () => {
  const agent_id = seedAgent();
  const purchase = freshPurchase(agent_id);
  const { page } = makeFakePage();

  const api: ApiClient = {
    create: async () => ({
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: `t-${Math.random()}`,
          name: "computer",
          input: { action: "screenshot" },
        },
      ],
    }),
  };

  await driveLoop({
    api,
    model: "claude-sonnet-4-6",
    page,
    ctx: {
      purchase_id: purchase.id,
      agent_id,
      intent: "x",
      merchant: "amazon.com",
      max_amount_cents: 500,
      reason: "r",
      signal: new AbortController().signal,
    },
    cardSource: { ensureCard: async () => ({ pan: "x", exp_month: 1, exp_year: 2030, name: "x" }) },
    cvv: "1",
    maxIterations: 3,
  });

  const final = getPurchase(purchase.id);
  assert.equal(final?.status, "failed");
  assert.match(final?.error ?? "", /max_iterations_3/);
});

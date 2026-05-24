import { test } from "node:test";
import assert from "node:assert/strict";
import type { CardPlain } from "./types.ts";

// Mock mode — no Chromium required in CI / cloud environments
process.env["TERMPAY_CHECKOUT_MOCK"] = "1";

const { chargeCard } = await import("./checkout.ts");

const mockCard: CardPlain = {
  pan: "4111111111111111",
  exp_month: 12,
  exp_year: 2030,
  name: "Test User",
};
const mockUrl = "https://console.anthropic.com/settings/billing";

test("chargeCard mock returns succeeded outcome", async () => {
  const controller = new AbortController();
  const outcome = await chargeCard(mockCard, mockUrl, 500, controller.signal);
  assert.equal(outcome.status, "succeeded");
  assert.equal(outcome.evidence, "MOCK");
});

test("chargeCard mock rejects when signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => chargeCard(mockCard, mockUrl, 500, controller.signal),
    (err: unknown) => err instanceof Error && err.message === "aborted",
  );
});

test("chargeCard mock rejects when signal aborts mid-flight", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(
    () => chargeCard(mockCard, mockUrl, 500, controller.signal),
    (err: unknown) => err instanceof Error && err.message === "aborted",
  );
});

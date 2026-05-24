import { test } from "node:test";
import assert from "node:assert/strict";
import { formatUSD, dollarsToCents, centsToDollars } from "./money.ts";

test("formatUSD formats cents as dollar string", () => {
  assert.equal(formatUSD(500), "$5.00");
  assert.equal(formatUSD(0), "$0.00");
  assert.equal(formatUSD(1099), "$10.99");
  assert.equal(formatUSD(100), "$1.00");
});

test("dollarsToCents converts dollars to cents", () => {
  assert.equal(dollarsToCents(5), 500);
  assert.equal(dollarsToCents(10.99), 1099);
  assert.equal(dollarsToCents(0), 0);
});

test("centsToDollars converts cents to dollars", () => {
  assert.equal(centsToDollars(500), 5);
  assert.equal(centsToDollars(100), 1);
  assert.equal(centsToDollars(0), 0);
});

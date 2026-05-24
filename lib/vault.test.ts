import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { encryptCard, decryptCard } from "./vault.ts";

test("encryptCard -> decryptCard round-trip", () => {
  const key = randomBytes(32);
  const card = {
    pan: "4242424242424242",
    exp_month: 12,
    exp_year: 2030,
    name: "TEST USER",
  };
  const blob = encryptCard(card, key);
  const back = decryptCard(blob, key);
  assert.deepEqual(back, card);
});

test("decrypt with wrong key fails", () => {
  const key = randomBytes(32);
  const wrong = randomBytes(32);
  const blob = encryptCard({ pan: "4", exp_month: 1, exp_year: 2030, name: "X" }, key);
  assert.throws(() => decryptCard(blob, wrong));
});

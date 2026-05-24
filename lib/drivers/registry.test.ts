import { test } from "node:test";
import assert from "node:assert";
import { randomUUID } from "node:crypto";

process.env["TERMPAY_DB_PATH"] =
  process.env["TERMPAY_DB_PATH"] ?? `/tmp/termpay-registry-test-${randomUUID()}.sqlite`;
process.env["TERMPAY_VAULT_KEY"] =
  process.env["TERMPAY_VAULT_KEY"] ??
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const { selectDriver } = await import("./registry.ts");
const { MockDriver } = await import("./mock.ts");

test("selectDriver returns MockDriver by default", () => {
  delete process.env["TERMPAY_DRIVER"];
  const d = selectDriver();
  assert.equal(d.name, "mock");
  assert.ok(d instanceof MockDriver);
});

test("selectDriver respects TERMPAY_DRIVER=mock", () => {
  process.env["TERMPAY_DRIVER"] = "mock";
  const d = selectDriver();
  assert.equal(d.name, "mock");
  delete process.env["TERMPAY_DRIVER"];
});

test("selectDriver throws for unknown driver", () => {
  process.env["TERMPAY_DRIVER"] = "nope";
  assert.throws(() => selectDriver(), /Unknown driver: nope/);
  delete process.env["TERMPAY_DRIVER"];
});

test("selectDriver falls back to mock even when ANTHROPIC_API_KEY is set (PR-D will switch)", () => {
  delete process.env["TERMPAY_DRIVER"];
  const prev = process.env["ANTHROPIC_API_KEY"];
  process.env["ANTHROPIC_API_KEY"] = "sk-test";
  try {
    assert.equal(selectDriver().name, "mock");
  } finally {
    if (prev === undefined) delete process.env["ANTHROPIC_API_KEY"];
    else process.env["ANTHROPIC_API_KEY"] = prev;
  }
});

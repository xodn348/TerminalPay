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
const { AnthropicComputerUseDriver } = await import("./anthropic_computer_use.ts");

test("selectDriver returns MockDriver when nothing configured", () => {
  delete process.env["TERMPAY_DRIVER"];
  const prev = process.env["ANTHROPIC_API_KEY"];
  delete process.env["ANTHROPIC_API_KEY"];
  try {
    const d = selectDriver();
    assert.equal(d.name, "mock");
    assert.ok(d instanceof MockDriver);
  } finally {
    if (prev !== undefined) process.env["ANTHROPIC_API_KEY"] = prev;
  }
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

test("selectDriver picks anthropic_computer_use when ANTHROPIC_API_KEY is set", () => {
  delete process.env["TERMPAY_DRIVER"];
  const prev = process.env["ANTHROPIC_API_KEY"];
  process.env["ANTHROPIC_API_KEY"] = "sk-test";
  try {
    const d = selectDriver();
    assert.equal(d.name, "anthropic_computer_use");
    assert.ok(d instanceof AnthropicComputerUseDriver);
  } finally {
    if (prev === undefined) delete process.env["ANTHROPIC_API_KEY"];
    else process.env["ANTHROPIC_API_KEY"] = prev;
  }
});

test("TERMPAY_DRIVER override beats ANTHROPIC_API_KEY", () => {
  process.env["TERMPAY_DRIVER"] = "mock";
  process.env["ANTHROPIC_API_KEY"] = "sk-test";
  try {
    assert.equal(selectDriver().name, "mock");
  } finally {
    delete process.env["TERMPAY_DRIVER"];
    delete process.env["ANTHROPIC_API_KEY"];
  }
});

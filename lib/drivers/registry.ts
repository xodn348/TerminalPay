import type { BrowserDriver } from "./index.ts";
import { MockDriver } from "./mock.ts";

// Selects the BrowserDriver implementation for the current process.
//
// Precedence:
//   1. TERMPAY_DRIVER=<name> env (explicit override)
//   2. "anthropic_computer_use" if ANTHROPIC_API_KEY is set (PR-D lands the driver)
//   3. "mock" otherwise
//
// PR-B only registers the MockDriver. PR-D adds anthropic_computer_use.
export function selectDriver(): BrowserDriver {
  const explicit = process.env["TERMPAY_DRIVER"];
  const name = explicit ?? defaultDriverName();

  switch (name) {
    case "mock":
      return new MockDriver();
    // case "anthropic_computer_use": lands in PR-D
    default:
      throw new Error(
        `Unknown driver: ${name}. Set TERMPAY_DRIVER to one of: mock`,
      );
  }
}

function defaultDriverName(): string {
  if (process.env["ANTHROPIC_API_KEY"]) {
    // PR-D activates the real driver here. Until then, fall back to mock so
    // a stray ANTHROPIC_API_KEY in the shell doesn't make purchase crash.
    return "mock";
  }
  return "mock";
}

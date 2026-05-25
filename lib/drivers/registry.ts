import type { BrowserDriver } from "./index.ts";
import { MockDriver } from "./mock.ts";
import { AnthropicComputerUseDriver } from "./anthropic_computer_use.ts";

// Selects the BrowserDriver implementation for the current process.
//
// Precedence:
//   1. TERMPAY_DRIVER=<name> env (explicit override)
//   2. "anthropic_computer_use" if ANTHROPIC_API_KEY is set
//   3. "mock" otherwise
export function selectDriver(): BrowserDriver {
  const explicit = process.env["TERMPAY_DRIVER"];
  const name = explicit ?? defaultDriverName();

  switch (name) {
    case "mock":
      return new MockDriver();
    case "anthropic_computer_use":
      return new AnthropicComputerUseDriver();
    default:
      throw new Error(
        `Unknown driver: ${name}. Set TERMPAY_DRIVER to one of: mock, anthropic_computer_use`,
      );
  }
}

function defaultDriverName(): string {
  if (process.env["ANTHROPIC_API_KEY"]) return "anthropic_computer_use";
  return "mock";
}

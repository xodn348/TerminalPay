// Selector map for console.anthropic.com/settings/billing.
// Verified against live page during G1 — update if selectors drift after Anthropic UI changes.
export const SELECTORS = {
  creditAmountInput: 'input[placeholder*="amount" i], input[name*="amount" i], input[type="number"]',
  submitCreditButton: 'button[type="submit"]',
  cardNumberField: 'input[autocomplete="cc-number"], input[name="cardnumber"], input[placeholder*="card number" i]',
  cardExpiryField: 'input[autocomplete="cc-exp"], input[name="exp-date"], input[placeholder*="MM" i]',
  cardCvcField: 'input[autocomplete="cc-csc"], input[name="cvc"], input[placeholder*="CVC" i], input[placeholder*="CVV" i]',
  successText: /credit.*added|payment.*success|thank.*you/i,
  errorText: /card.*declin|payment.*fail|insufficient/i,
};

export const CHECKOUT_URL = "https://console.anthropic.com/settings/billing";

export function detect3DS(frameNames: string[]): boolean {
  return frameNames.some(
    (n) =>
      n.toLowerCase().includes("3ds") ||
      n.toLowerCase().includes("challenge") ||
      n.toLowerCase().includes("acs"),
  );
}

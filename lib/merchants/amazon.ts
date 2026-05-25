// Selector map for Amazon checkout (best-effort starting points).
//
// Amazon's payment flow shows a "Use a different payment method" link on the
// review page; clicking it reveals an "Add a new card" form. We target the
// fields in that form. termpay drives `signal_checkout_reached` from the
// Computer Use loop the moment those fields are visible, then fills the card
// directly via Patchright — the LLM never sees raw card digits.
//
// These selectors WILL drift. Update them during the PR-E real-Amazon
// verification run, then commit the corrections alongside the order receipt
// screenshot.
export const SELECTORS = {
  // "Use a different payment method" link on the review page
  useDifferentPaymentMethod:
    'a:has-text("Use a different payment method"), input[name*="payment"]',

  // Card entry form
  cardNumberField:
    'input#addCreditCardNumber, input[name="ppw-accountHolderName"], input[autocomplete="cc-number"]',
  cardExpiryMonthSelect: 'select#ccMonth, select[name*="ccMonth"]',
  cardExpiryYearSelect: 'select#ccYear, select[name*="ccYear"]',
  cardNameField:
    'input#ppw-accountHolderName, input[name*="cardHolderName"], input[autocomplete="cc-name"]',
  cardCvvField: 'input[autocomplete="cc-csc"], input[name*="cvv"], input[name*="cvc"]',
  saveCardCheckbox: 'input[type="checkbox"][name*="save"], input#saveCard',
  addCardButton:
    'input[name="ppw-widgetEvent:AddCreditCardEvent"], input[aria-labelledby*="Add your card"]',

  // Final place-order trigger on the review page
  placeOrderButton:
    'input[name="placeYourOrder1"], input#placeYourOrder, button:has-text("Place your order")',

  // Success / receipt confirmation
  orderConfirmation:
    'div:has-text("Order placed"), div:has-text("Thank you, your order"), h1:has-text("Thanks")',
  orderNumberPattern: /Order #?\s*([0-9-]{10,})/i,
};

export const HOME_URL = "https://www.amazon.com";

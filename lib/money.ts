export function formatUSD(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function dollarsToCents(usd: number): number {
  return Math.round(usd * 100);
}

export function centsToDollars(cents: number): number {
  return cents / 100;
}

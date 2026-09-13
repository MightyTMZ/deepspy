/**
 * Exact money handling.
 *
 * The frozen contracts carry dollars as JS numbers (`ActionReceipt.usd`,
 * spend `usd` / `cap`). Floats are converted to integer micro-dollars exactly
 * once, here, at the write boundary. Everything downstream — storage,
 * aggregation, the spend endpoint — uses integers only. We never SUM floats.
 */

export const MICRO_PER_USD = 1_000_000;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/** Convert a dollar amount from a contract event into integer micro-dollars. */
export function usdToMicro(usd: number): number {
  if (typeof usd !== "number" || !Number.isFinite(usd)) {
    throw new MoneyError(`usd must be a finite number, received ${String(usd)}`);
  }
  if (usd < 0) {
    throw new MoneyError(`usd must not be negative, received ${usd}`);
  }
  // Round half-away-from-zero at micro precision. Inputs are non-negative, so
  // Math.round is exact enough and deterministic for our magnitudes (<$100).
  const micro = Math.round(usd * MICRO_PER_USD);
  if (!Number.isSafeInteger(micro)) {
    throw new MoneyError(`usd ${usd} does not fit in a safe micro-dollar integer`);
  }
  return micro;
}

/** Convert integer micro-dollars back to dollars for presentation only. */
export function microToUsd(micro: number): number {
  if (!Number.isSafeInteger(micro)) {
    throw new MoneyError(`micro-dollars must be a safe integer, received ${String(micro)}`);
  }
  return micro / MICRO_PER_USD;
}

/** Format micro-dollars as an exact decimal string, e.g. 1234567 -> "1.234567". */
export function microToDecimalString(micro: number): string {
  if (!Number.isSafeInteger(micro)) {
    throw new MoneyError(`micro-dollars must be a safe integer, received ${String(micro)}`);
  }
  const negative = micro < 0;
  const abs = Math.abs(micro);
  const whole = Math.floor(abs / MICRO_PER_USD);
  const frac = String(abs % MICRO_PER_USD).padStart(6, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

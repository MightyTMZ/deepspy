/** UTC ISO-8601 timestamps, millisecond precision, always `Z`-suffixed. */

export function nowIso(): string {
  return new Date().toISOString();
}

/** Normalise any accepted timestamp input to a UTC ISO-8601 string. */
export function toIso(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  if (Number.isNaN(ms)) {
    throw new TypeError(`invalid timestamp: ${String(value)}`);
  }
  return date.toISOString();
}

/** True when the string is a UTC ISO-8601 timestamp we would have written. */
export function isIsoUtc(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

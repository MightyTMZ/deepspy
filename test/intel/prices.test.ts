// Price parsing without a model: decimal strings, currency, period; promo lines yield the recurring price.
import { describe, it, expect } from "vitest";
import { parsePrice } from "../../src/intel/prices.js";

describe("parsePrice", () => {
  it("reads symbol-first and code-last formats", () => {
    expect(parsePrice("$13.99 / month")).toEqual({ amount: "13.99", currency: "USD", period: "month" });
    expect(parsePrice("CA$11.99 per month")).toEqual({ amount: "11.99", currency: "CAD", period: "month" });
    expect(parsePrice("Danach 12,99 €/Monat")).toEqual({ amount: "12.99", currency: "EUR", period: "month" });
    expect(parsePrice("£96 per year")).toEqual({ amount: "96", currency: "GBP", period: "year" });
  });
  it("takes the recurring price from a promo line and leaves unknown periods null", () => {
    expect(parsePrice("$0 for 3 months, then $12.99 per month after")).toEqual({ amount: "12.99", currency: "USD", period: "month" });
    expect(parsePrice("Enterprise from $1,200")).toEqual({ amount: "1200", currency: "USD", period: null });
    expect(parsePrice("no price here")).toBeNull();
  });
});

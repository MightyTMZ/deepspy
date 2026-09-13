// C12: wall classifier on fixtures. Offline.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { classifyFromDom } from "../../src/steel/walls.js";
import { fixtureUrl, localPage } from "./helpers.js";
import type { Browser, Page } from "playwright-core";

let browser: Browser; let page: Page;
beforeAll(async () => { ({ browser, page } = await localPage()); });
afterAll(async () => { await browser.close(); });

const cases: Array<[string, string | null]> = [
  ["captcha-wall.html", "captcha"],
  ["login-wall.html", "login"],
  ["2fa-wall.html", "2fa"],
  ["kyc-wall.html", "kyc"],
  ["payment-wall.html", "payment"],
  ["consent-wall.html", "consent"],
  ["settings-page.html", null],
  ["kyc-marketing.html", null], // product copy about identity verification with nothing to fill in is not a wall
];

describe("C12 wall classifier", () => {
  for (const [file, expected] of cases) {
    it(`${file} -> ${expected ?? "none"}`, async () => {
      await page.goto(fixtureUrl(file));
      const v = await classifyFromDom(page);
      expect(v.wall).toBe(expected);
    });
  }
});

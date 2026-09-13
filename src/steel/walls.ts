// Owner: Fahad. Layer 4: classify a screen as a wall. Test: C12.
// DOM first, screenshot second. Both B and C call this; C owns it.

import type { Page } from "playwright-core";
import type { WallDetected } from "@periscope/contracts";

export type WallKind = WallDetected["wall"];
export type WallVerdict = { wall: WallKind; confidence: number; evidence: string } | { wall: null };

const DOM_RULES: Array<{ wall: WallKind; test: (t: string, html: string) => boolean }> = [
  { wall: "captcha", test: (t, h) => /captcha|are you human|verify you are|hcaptcha|turnstile/i.test(t + h) },
  { wall: "payment", test: (t, h) => /card number|cvv|cvc|expiry|expiration|billing address|iban/i.test(t) || /autocomplete=["']cc-number/i.test(h) },
  { wall: "2fa", test: (t) => /two[- ]factor|authenticator app|6-digit code|verification code from your app|enter the code/i.test(t) },
  { wall: "email_code", test: (t) => /code (we )?sent to your email|check your (inbox|email) for a code|magic link/i.test(t) },
  { wall: "kyc", test: (t) => /upload (your )?(id|passport|driver)|identity verification|verify your identity|selfie/i.test(t) },
  { wall: "consent", test: (t, h) => /accept all cookies|cookie preferences|we use cookies/i.test(t) && /cookie|consent/i.test(h) },
  { wall: "login", test: (t, h) => /sign in|log in|login/i.test(t) && /type=["']password/i.test(h) },
];

/** Classify from the DOM. Returns { wall: null } when nothing matches. */
export async function classifyFromDom(page: Page): Promise<WallVerdict> {
  const text = await page.locator("body").innerText().catch(() => "");
  const html = await page.content().catch(() => "");
  for (const rule of DOM_RULES) {
    if (rule.test(text, html)) return { wall: rule.wall, confidence: 0.8, evidence: `dom:${rule.wall}` };
  }
  const hasForm = /<form[\s>]/i.test(html) && /type=["']submit|<button/i.test(html);
  if (hasForm && !text.trim()) return { wall: "unknown_form", confidence: 0.4, evidence: "dom:form-without-text" };
  return { wall: null };
}

/** Screenshot classifier when the DOM is empty. Implemented by the model adapter (Person B); C never makes a model call. */
export type ScreenshotClassifier = (screenshotPath: string) => Promise<WallVerdict>;

export async function classify(page: Page, screenshotPath?: string, byScreenshot?: ScreenshotClassifier): Promise<WallVerdict> {
  const dom = await classifyFromDom(page);
  if (dom.wall) return dom;
  if (screenshotPath && byScreenshot) return byScreenshot(screenshotPath);
  return { wall: null };
}

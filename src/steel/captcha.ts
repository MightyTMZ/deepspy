// Owner: Fahad. CAPTCHA policy: let Steel's solver try first; only escalate to a human when it fails or cannot.
// Steel solves reCAPTCHA v2/v3, Cloudflare Turnstile, and image-to-text when the session was created with
// solveCaptcha: true (needs a $10 paid balance on the Launch plan; set STEEL_CAPTCHA=1 to enable).
// Status is polled via client.sessions.captchas.status(sessionId). Not covered: hCaptcha, FunCaptcha/Arkose,
// GeeTest, DataDome, Imperva, PerimeterX, AWS WAF. Verified live Sept 13: Turnstile reached "solved" every run,
// reCAPTCHA v2 solved once and was missed once, hCaptcha never detected.

export type CaptchaTaskStatus =
  | "detected" | "solving" | "solved" | "failed_to_solve" | "undetected" | "validating" | "validation_failed" | "failed_to_detect";

export interface CaptchaStatus {
  isSolvingCaptcha: boolean;
  tasks: Array<{ type?: string; status: CaptchaTaskStatus }>;
}

export type CaptchaOutcome =
  | { outcome: "solved" }
  | { outcome: "not_supported"; reason: string }
  | { outcome: "failed"; reason: string }
  | { outcome: "timeout" };

// CAPTCHA families Steel's solver does not handle. Match real widget markup (script and iframe sources,
// widget classes), never a mere mention of a vendor in page text, so a page that links to "hCaptcha demo"
// is not misclassified.
const UNSUPPORTED: Array<[string, RegExp]> = [
  ["hcaptcha", /js\.hcaptcha\.com\/1\/api|hcaptcha\.com\/captcha|class=["'][^"']*h-captcha/i],
  ["funcaptcha", /funcaptcha\.com|arkoselabs\.com\/(v2|fc)|name=["']fc-token/i],
  ["geetest", /static\.geetest\.com|class=["'][^"']*geetest_/i],
  ["datadome", /captcha-delivery\.com|js\.datadome\.co|window\.ddjskey/i],
  ["imperva", /_Incapsula_Resource|incapsula\.com/i],
  ["perimeterx", /px-captcha|client\.px-cloud\.net|_pxAppId/i],
  ["awswaf", /captcha\.awswaf\.com|aws-waf-token/i],
];

export function unsupportedCaptchaFamily(html: string): string | null {
  for (const [name, re] of UNSUPPORTED) if (re.test(html)) return name;
  return null;
}

/**
 * Wait for Steel to solve the CAPTCHA on this session. Returns "solved" when the page is past it,
 * "failed" when Steel reports a failure state, "timeout" when nothing resolves in time,
 * "not_supported" when the page shows a CAPTCHA family Steel cannot solve.
 */
export async function waitForSteelSolve(
  getStatus: () => Promise<CaptchaStatus>,
  pageHtml: () => Promise<string>,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<CaptchaOutcome> {
  const family = unsupportedCaptchaFamily(await pageHtml());
  if (family) return { outcome: "not_supported", reason: family };

  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    const s = await getStatus();
    const statuses = s.tasks.map((t) => t.status);
    if (statuses.some((x) => x === "solved")) return { outcome: "solved" };
    const failed = statuses.find((x) => x === "failed_to_solve" || x === "validation_failed" || x === "failed_to_detect");
    if (failed && !s.isSolvingCaptcha) return { outcome: "failed", reason: failed };
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 2000));
  }
  return { outcome: "timeout" };
}

// C8 offline part: redaction never lets a password reach logs or prompts. The live part runs in live.test.ts.
import { describe, it, expect } from "vitest";
import { redact, injectionOptions } from "../../src/steel/credentials.js";

describe("C8 credentials hygiene", () => {
  it("redacts secrets in any text bound for logs or prompts", () => {
    const s = redact('password: hunter2 totp=JBSWY3DPEHPK3PXP {"passwd":"abc"}');
    expect(s).not.toContain("hunter2"); expect(s).not.toContain("JBSWY3DP"); expect(s).not.toContain("abc");
  });
  it("injection options never auto-submit and always blur", () => {
    const o = injectionOptions({ namespace: "x:y", origin: "https://app.test", hasTotp: true }) as { credentials: { autoSubmit: boolean; blurFields: boolean; exactOrigin: boolean } };
    expect(o.credentials.autoSubmit).toBe(false); expect(o.credentials.blurFields).toBe(true); expect(o.credentials.exactOrigin).toBe(true);
  });
});

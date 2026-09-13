// Owner: Fahad. Credentials through Steel only. Test: C8.
//
// Rules: credentials are stored once through Steel's credentials feature, injected by exact origin,
// fields blurred, auto-submit off by default, TOTP where supported. The model never receives a
// credential value or a login-page screenshot. This module never holds a password in memory
// longer than the call that stores it, and never logs one.

export interface CredentialRef {
  namespace: string;   // one per account, e.g. "competitorA:trial1"
  origin: string;      // exact origin the credential is allowed on
  hasTotp: boolean;
}

export interface StoreCredentialInput {
  namespace: string;
  origin: string;
  username: string;
  password: string;    // passed straight to Steel; never persisted here
  totpSecret?: string;
}

export async function storeCredential(input: StoreCredentialInput): Promise<CredentialRef> {
  // TODO(C8): call Steel's credentials API. Do not console.log input.
  void input;
  throw new Error("not implemented");
}

/** Session create options that make Steel inject the credential on the login page. */
export function injectionOptions(ref: CredentialRef): Record<string, unknown> {
  return {
    credentials: { namespace: ref.namespace, autoSubmit: false, blurFields: true, exactOrigin: true },
  };
}

/** Redact anything that looks like a secret before it reaches logs or prompts. */
export function redact(text: string): string {
  return text.replace(/(password|passwd|pwd|totp|secret)["']?\s*[:=]\s*["']?[^\s"',}]+/gi, "$1=[redacted]");
}

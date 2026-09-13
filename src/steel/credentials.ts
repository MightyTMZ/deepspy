// Owner: Fahad. Credentials through Steel only. Test: C8.
//
// Rules: credentials are stored once through Steel's credentials API, injected by exact origin, fields blurred,
// auto-submit off, TOTP where the trial supports it. The model never receives a credential value or a login-page
// screenshot. This module never holds a password longer than the call that stores it, and never logs one.

import type { SteelAdapter } from "./steel-adapter.js";

export interface CredentialRef {
  namespace: string;   // one per account, e.g. "linear:trial1"
  origin: string;      // exact origin the credential is allowed on
  hasTotp: boolean;
}

export interface StoreCredentialInput {
  namespace: string;
  origin: string;
  username: string;
  password: string;    // passed straight to Steel; never persisted here
  totpSecret?: string;
  label?: string;
}

/** Namespace convention: "<competitor>:<accountRef>". */
export function credentialNamespace(competitor: string, accountRef: string): string {
  return `${competitor}:${accountRef}`;
}

export async function storeCredential(adapter: SteelAdapter, input: StoreCredentialInput): Promise<CredentialRef> {
  await adapter.storeCredential(input);
  return { namespace: input.namespace, origin: input.origin, hasTotp: Boolean(input.totpSecret) };
}

/** Session create options that make Steel inject the credential on the login page. */
export function injectionOptions(ref: CredentialRef): Record<string, unknown> {
  return {
    namespace: ref.namespace,
    credentials: { autoSubmit: false, blurFields: true, exactOrigin: true },
  };
}

/** Redact anything that looks like a secret before it reaches logs or prompts. */
export function redact(text: string): string {
  return text.replace(/(password|passwd|pwd|totp|secret)["']?\s*[:=]\s*["']?[^\s"',}]+/gi, "$1=[redacted]");
}

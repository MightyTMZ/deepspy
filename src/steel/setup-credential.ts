// Owner: Fahad. CLI: store a trial account's login through Steel's credentials API so every walker session
// can re-login automatically. Test: C8. Steel types the password into the page and blurs it; the model never sees it.
//
//   npm run setup-credential -- --competitor linear --origin https://linear.app --username you@example.com --account trial1 [--totp JBSWY3DP...]
//
// The password is read from the terminal with echo off. It is sent to Steel once and never written to disk or logs.
// Why this exists: Steel profiles restore localStorage but not cookies (observed Sept 13), so sites that keep
// login state in cookies need injection on every session. Record the account with setup-account first so the
// profile, home country, and signed-in indicator exist; this adds the credential namespace to that record.

import readline from "node:readline";
import { SteelAdapter } from "./steel-adapter.js";
import { credentialNamespace } from "./credentials.js";
import { loadProfiles, saveProfile } from "./profiles.js";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v && fallback === undefined) throw new Error(`--${name} is required`);
  return v ?? (fallback as string);
}

function readSecret(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = process.stdout as NodeJS.WriteStream & { muted?: boolean };
    process.stdout.write(prompt);
    const orig = out.write.bind(out);
    (out as unknown as { write: typeof orig }).write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      // swallow echoed keystrokes while the secret is typed
      if (typeof chunk === "string" && !chunk.includes("\n")) return true;
      return (orig as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof orig;
    rl.question("", (answer) => {
      (out as unknown as { write: typeof orig }).write = orig;
      process.stdout.write("\n");
      rl.close();
      resolve(answer);
    });
  });
}

const competitor = arg("competitor");
const origin = new URL(arg("origin")).origin; // exact origin only
const username = arg("username");
const accountRef = arg("account", "trial1");
const totp = process.argv.includes("--totp") ? arg("totp") : undefined;

const password = await readSecret(`Password for ${username} at ${origin} (hidden): `);
if (!password) throw new Error("empty password");

const adapter = new SteelAdapter({ apiKey: process.env.STEEL_API_KEY ?? "" });
const namespace = credentialNamespace(competitor, accountRef);
await adapter.storeCredential({ namespace, origin, username, password, totpSecret: totp, label: `${competitor}/${accountRef}` });

const existing = loadProfiles().find((p) => p.competitor === competitor && p.accountRef === accountRef);
saveProfile({
  profileId: existing?.profileId ?? `pending:${namespace}`,
  competitor, accountRef,
  homeCountry: existing?.homeCountry ?? null,
  signedInIndicator: existing?.signedInIndicator ?? "",
  createdAt: existing?.createdAt ?? new Date().toISOString(),
  ready: existing?.ready ?? false,
  credentialNamespace: namespace,
  loginOrigin: origin,
});
console.log(`Stored credential in Steel namespace "${namespace}" for ${origin}. Walker sessions for ${competitor}/${accountRef} will inject it (auto-submit off, fields blurred).`);

// Owner: Fahad. CLI: a human logs into a trial once; the profile is saved for every later walk. Test: C5.
//
//   npm run setup-account -- --competitor linear --url https://linear.app/login --indicator "Inbox" --account trial1 --country CA
//
// The human types the password in the live view. Nothing here ever sees it.

import { SteelAdapter, defaultVantage } from "./steel-adapter.js";
import { saveProfile } from "./profiles.js";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v && fallback === undefined) throw new Error(`--${name} is required`);
  return v ?? (fallback as string);
}

const competitor = arg("competitor");
const url = arg("url");
const indicator = arg("indicator");
const accountRef = arg("account", "trial1");
const country = arg("country", "CA");

const adapter = new SteelAdapter({ apiKey: process.env.STEEL_API_KEY ?? "" });
const handle = await adapter.open({ vantage: defaultVantage({ country, authenticated: true }), purpose: "setup", accountRef });

console.log("\nOpen this live view and log in by hand:\n  " + handle.viewerUrl + "\n");
await handle.page.goto(url, { waitUntil: "domcontentloaded" });

const deadline = Date.now() + 8 * 60 * 1000;
let signedIn = false;
while (Date.now() < deadline) {
  const text = await handle.page.locator("body").innerText().catch(() => "");
  if (text.includes(indicator)) { signedIn = true; break; }
  await new Promise((r) => setTimeout(r, 3000));
}

if (!signedIn) {
  console.error("Signed-in indicator not seen within 8 minutes. Releasing without saving.");
  await handle.release();
  process.exit(1);
}

await handle.release(); // persistProfile was set on create; Steel saves the profile on release
const profileId = handle.profileId ?? handle.sessionId; // TODO(C5): read the real profile id from the released session
saveProfile({ profileId, competitor, accountRef, homeCountry: country, signedInIndicator: indicator, createdAt: new Date().toISOString(), ready: false });
console.log(`Profile recorded for ${competitor}/${accountRef}: ${profileId}. Run C6 readiness before first use.`);

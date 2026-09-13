// Owner: Fahad. Profiles: saved logins, readiness, home country. Tests: C5, C6, C7.

import fs from "node:fs";
import path from "node:path";

export interface ProfileRecord {
  profileId: string;
  competitor: string;
  accountRef: string;        // opaque; never a password
  homeCountry: string | null;
  signedInIndicator: string; // text or selector that proves the login worked
  createdAt: string;
  ready: boolean;
  /** Steel credentials namespace for this account, when a credential was stored (setup-credential CLI). */
  credentialNamespace?: string;
  /** Exact origin the credential is bound to. */
  loginOrigin?: string;
}

const file = () => path.join(process.env.PERISCOPE_DATA_DIR ?? "./data", "profiles.local.json");

export function loadProfiles(): ProfileRecord[] {
  const f = file();
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as ProfileRecord[]) : [];
}

export function saveProfile(record: ProfileRecord): void {
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const all = loadProfiles().filter((p) => p.profileId !== record.profileId);
  all.push(record);
  fs.writeFileSync(f, JSON.stringify(all, null, 2));
}

export function profileFor(competitor: string, accountRef: string): ProfileRecord | undefined {
  return loadProfiles().find((p) => p.competitor === competitor && p.accountRef === accountRef);
}

/** C6: Steel persists a profile asynchronously after release; poll before reuse. */
export async function waitUntilReady(profileId: string, isReady: (id: string) => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isReady(profileId)) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`profile ${profileId} not ready after ${timeoutMs}ms`);
}

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright-core";

/** Evidence stays local. Never send account/login screenshots to a model. */
export async function saveScreenshot(page: Page): Promise<string | undefined> {
  try {
    const dir = path.resolve(process.env.PERISCOPE_DATA_DIR ?? "data", "screenshots");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${randomUUID()}.png`);
    await writeFile(file, await page.screenshot({ type: "png", timeout: 5000 }));
    return file;
  } catch { return undefined; }
}

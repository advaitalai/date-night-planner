import fs from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { config } from "../config";

const contexts = new Map<string, Promise<BrowserContext>>();

/**
 * A persistent Chromium profile per platform, so logins survive restarts
 * (stored on the Fly volume next to the database).
 */
export function browserFor(platform: string): Promise<BrowserContext> {
  let ctx = contexts.get(platform);
  if (!ctx) {
    const dir = path.join(config.dataDir, "browser", platform);
    fs.mkdirSync(dir, { recursive: true });
    ctx = chromium.launchPersistentContext(dir, {
      headless: true,
      executablePath: process.env.CHROMIUM_PATH || undefined,
      locale: "ja-JP",
      timezoneId: "Asia/Tokyo",
      viewport: { width: 1280, height: 900 },
    });
    contexts.set(platform, ctx);
  }
  return ctx;
}

/** Run `fn` on a fresh page; on failure save a screenshot for debugging and rethrow. */
export async function withPage<T>(platform: string, fn: (page: Page) => Promise<T>): Promise<T> {
  const ctx = await browserFor(platform);
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  try {
    return await fn(page);
  } catch (err) {
    const dir = path.join(config.dataDir, "screens");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${platform}-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: true }).catch(() => {});
    (err as Error).message += ` (screenshot: ${file})`;
    throw err;
  } finally {
    await page.close().catch(() => {});
  }
}

export async function closeBrowsers(): Promise<void> {
  for (const ctx of contexts.values()) await (await ctx).close().catch(() => {});
  contexts.clear();
}

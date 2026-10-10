/**
 * One-time login for booking sites whose accounts use "Sign in with Google"
 * (the bot can't type a Google password itself).
 *
 *   npm run browser-login -- tabelog      (or tablecheck)
 *
 * Opens a visible browser with the bot's saved profile. Log in by hand, then
 * close the window: the session is stored under DATA_DIR/browser/<site> and
 * reused by the bot. Run it on your own computer, then copy that folder to the
 * server (see README), or run it on any machine with a screen.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { config } from "../config";

const SITES: Record<string, string> = {
  tabelog: "https://tabelog.com/login/",
  tablecheck: "https://www.tablecheck.com/en/login",
};

const site = process.argv[2];
if (!site || !SITES[site]) {
  console.error(`usage: npm run browser-login -- <${Object.keys(SITES).join("|")}>`);
  process.exit(1);
}

const dir = path.join(config.dataDir, "browser", site);
fs.mkdirSync(dir, { recursive: true });
const ctx = await chromium.launchPersistentContext(dir, {
  headless: false,
  // A regular installed Chrome is less likely to be refused by Google sign-in.
  channel: process.env.CHROMIUM_PATH ? undefined : "chrome",
  executablePath: process.env.CHROMIUM_PATH || undefined,
  locale: "ja-JP",
  timezoneId: "Asia/Tokyo",
  viewport: null,
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto(SITES[site]);
console.log(`Log in to ${site} in the browser window (use "Sign in with Google"), then close the window.`);
await new Promise<void>((resolve) => ctx.on("close", () => resolve()));
console.log(`Saved login to ${dir}`);

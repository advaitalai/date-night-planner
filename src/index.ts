import fs from "node:fs";
import path from "node:path";
import { closeBrowsers } from "./booking/browser";
import { config } from "./config";
import { kvGet, kvSet } from "./db";
import { getPrefs, updatePrefs } from "./db/repo";
import { gmailWatch } from "./jobs/gmailWatch";
import { startScheduler, stopScheduler } from "./jobs/scheduler";
import { takeoutWatch } from "./jobs/takeoutWatch";
import { ensureWeeklyJobs, registerWeeklyJobs } from "./jobs/weekly";
import { registerCallJobs } from "./booking/calls";
import { MIN_TWILIO_BALANCE, twilioBalance } from "./booking/phone";
import { geocode } from "./places/google";
import { startWhatsApp } from "./wa/whatsapp";
import { logToFile } from "./logbook";
import { startWebServer } from "./web/server";

function every(ms: number, name: string, fn: () => Promise<void>): void {
  const run = () => fn().catch((err) => console.error(`${name} failed:`, err));
  setTimeout(run, 10_000);
  setInterval(run, ms);
}

/** Replace the approximate anchor coordinates with geocoded ones, once. */
async function geocodeAnchors(): Promise<void> {
  if (!config.google.mapsKey || kvGet("anchors_geocoded", false)) return;
  const prefs = getPrefs();
  const anchors = { ...prefs.anchors };
  for (const [key, a] of Object.entries(anchors)) {
    const ll = await geocode(a.address).catch(() => null);
    if (ll) anchors[key] = { ...a, ...ll };
  }
  updatePrefs({ anchors });
  kvSet("anchors_geocoded", true);
}

/**
 * Only one copy of the bot may run: two copies sharing one WhatsApp login knock
 * each other off (endless reconnects), corrupt the encryption keys ("Bad MAC")
 * and both send reminders.
 */
function singleInstance(): void {
  const file = path.join(config.dataDir, "bot.pid");
  const other = Number(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : 0);
  if (other && other !== process.pid) {
    try {
      process.kill(other, 0);
      console.error(`Another copy of the bot is already running (process ${other}). Stop it first (Ctrl+C in its window, or: kill ${other}).`);
      process.exit(1);
    } catch {
      // that process is gone; take over
    }
  }
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(file, String(process.pid));
  process.on("exit", () => {
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === String(process.pid)) fs.unlinkSync(file);
  });
}

async function main(): Promise<void> {
  singleInstance();
  logToFile();
  console.log(`date-night-planner starting (DRY_RUN=${config.dryRun ? "on" : "off"}, model ${config.anthropicModel})`);
  registerWeeklyJobs();
  registerCallJobs();
  ensureWeeklyJobs();
  startScheduler();
  every(5 * 60_000, "gmail watch", gmailWatch);
  every(30 * 60_000, "takeout watch", takeoutWatch);
  await geocodeAnchors();
  const balance = await twilioBalance();
  if (balance != null) console.log(`Twilio balance: $${balance.toFixed(2)}${balance < MIN_TWILIO_BALANCE ? " ⚠️ too low for calls, top up at console.twilio.com" : ""}`);
  await startWebServer();
  await startWhatsApp();
}

// A failed background request (e.g. a WhatsApp timeout) is logged, never fatal: the bot keeps running.
process.on("unhandledRejection", (err) => console.error("unhandled error (bot keeps running):", err));

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    stopScheduler();
    await closeBrowsers();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

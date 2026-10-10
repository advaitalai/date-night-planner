import { closeBrowsers } from "./booking/browser";
import { config } from "./config";
import { kvGet, kvSet } from "./db";
import { getPrefs, updatePrefs } from "./db/repo";
import { gmailWatch } from "./jobs/gmailWatch";
import { startScheduler, stopScheduler } from "./jobs/scheduler";
import { takeoutWatch } from "./jobs/takeoutWatch";
import { ensureWeeklyJobs, registerWeeklyJobs } from "./jobs/weekly";
import { geocode } from "./places/google";
import { startWhatsApp } from "./wa/whatsapp";
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

async function main(): Promise<void> {
  console.log(`date-night-planner starting (DRY_RUN=${config.dryRun ? "on" : "off"}, model ${config.anthropicModel})`);
  registerWeeklyJobs();
  ensureWeeklyJobs();
  startScheduler();
  every(5 * 60_000, "gmail watch", gmailWatch);
  every(30 * 60_000, "takeout watch", takeoutWatch);
  await geocodeAnchors();
  await startWebServer();
  await startWhatsApp();
}

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

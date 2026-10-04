/**
 * Bookability audit: how can each saved place be booked?
 *   npm run audit -- [file.csv person]
 * Optionally imports a CSV first. Needs GOOGLE_MAPS_API_KEY and open internet
 * (TableCheck, Tabelog, restaurant websites). Writes audit-report.md.
 */
import fs from "node:fs";
import { detectChannel } from "../booking/detect";
import { config, PEOPLE } from "../config";
import { kvSet } from "../db";
import { getPrefs, listPlaces, updatePlace } from "../db/repo";
import { importSavedList } from "../places/takeout";
import { enrich } from "../recommender/candidates";
import type { BookingChannel } from "../types";
import { estimateTravelMin } from "../util/geo";

const [file, person] = process.argv.slice(2);
if (file) {
  if (!PEOPLE.includes(person as never)) throw new Error(`usage: npm run audit -- <file.csv> <${PEOPLE.join("|")}>`);
  const r = await importSavedList(fs.readFileSync(file, "utf8"), "import", person, Boolean(config.google.mapsKey));
  console.log(`imported ${r.imported}`);
}
if (!config.google.mapsKey) console.warn("GOOGLE_MAPS_API_KEY not set: places can't be resolved, results will be mostly 'unknown'.");

const home = getPrefs().anchors.home;
const rows: { name: string; channel: BookingChannel; evidence: string; minutes: number | null }[] = [];
for (const place of listPlaces("source != 'discovered'")) {
  const enriched = await enrich(place, { detect: false, profile: false });
  const d = await detectChannel(enriched);
  updatePlace(place.id, { booking_channel: d.channel, ...d.patch });
  kvSet(`detect:${place.id}`, new Date().toISOString());
  const minutes = enriched.lat != null && enriched.lng != null ? estimateTravelMin(home, { lat: enriched.lat, lng: enriched.lng }) : null;
  rows.push({ name: place.name, channel: d.channel, evidence: d.evidence, minutes });
  console.log(`${d.channel.padEnd(14)} ${place.name} — ${d.evidence}`);
}

const LABEL: Record<BookingChannel, string> = {
  tablecheck: "Online — TableCheck (bot books)",
  tabelog: "Online — Tabelog (bot books)",
  email: "Email (bot books)",
  other_online: "Online — other platform (not yet automated)",
  phone: "Phone only",
  walkin: "Walk-in / no reservations",
  not_restaurant: "Not a dinner place",
  unknown: "Unknown",
};

function summary(subset: typeof rows): string {
  const dining = subset.filter((r) => r.channel !== "not_restaurant");
  const counts = new Map<BookingChannel, number>();
  for (const r of subset) counts.set(r.channel, (counts.get(r.channel) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `| ${LABEL[c]} | ${n} | ${c === "not_restaurant" ? "—" : `${Math.round((100 * n) / Math.max(1, dining.length))}%`} |`)
    .join("\n");
}

const near = rows.filter((r) => r.minutes != null && r.minutes <= getPrefs().maxTravelMin);
const report = `# Saved places: how they can be booked

${rows.length} saved places; percentages are of dinner places (excluding cafés, spas, galleries…).

## All saved places

| Channel | Places | Share |
|---|---|---|
${summary(rows)}

## Within ${getPrefs().maxTravelMin} min of home (${near.length})

| Channel | Places | Share |
|---|---|---|
${summary(near)}

## Detail

| Place | Channel | Evidence | ~Min from home |
|---|---|---|---|
${rows.map((r) => `| ${r.name} | ${r.channel} | ${r.evidence} | ${r.minutes ?? "?"} |`).join("\n")}
`;
fs.writeFileSync("audit-report.md", report);
console.log("\nWrote audit-report.md");

/**
 * Import a Google Takeout "Saved" CSV for one person.
 *   npm run import-csv -- <file.csv> <Advait|Emily> [list name]
 * With GOOGLE_MAPS_API_KEY set, each new place gets two cheap lookups and only
 * dinner places (restaurants, bars) within reach of home or work are kept.
 * Prints what was kept and skipped. Run it on the server (the database is there).
 */
import fs from "node:fs";
import path from "node:path";
import { config, PEOPLE } from "../config";
import { importSavedList } from "../places/takeout";

const [file, person, listName] = process.argv.slice(2);
if (!file || !PEOPLE.includes(person as never)) {
  console.error(`usage: npm run import-csv -- <file.csv> <${PEOPLE.join("|")}> [list name]`);
  process.exit(1);
}

const csv = fs.readFileSync(file, "utf8");
const r = await importSavedList(csv, listName ?? path.basename(file, ".csv"), person, Boolean(config.google.mapsKey), (done, total) => {
  if (done % 50 === 0 || done === total) process.stdout.write(`\r${done}/${total} looked at…`);
});
console.log(`\n\n${person}'s list "${listName ?? path.basename(file, ".csv")}": ${r.rows} places`);
console.log(`- Added: ${r.imported}${config.google.mapsKey ? " (dinner places within reach of home or work)" : " (no GOOGLE_MAPS_API_KEY: stored unresolved)"}`);
console.log(`- Already known, now marked as saved by ${person} too: ${r.alreadyKnown}`);
console.log(`- Skipped, not a dinner place (café, shop, hotel…): ${r.skipped.notDinner.length}`);
console.log(`- Skipped, too far from home and work: ${r.skipped.tooFar.length}`);
console.log(`- Skipped, permanently closed: ${r.skipped.closed.length}`);
console.log(`- Not found on Google: ${r.unresolved.length}${r.unresolved.length ? ` (${r.unresolved.slice(0, 15).join(", ")}${r.unresolved.length > 15 ? "…" : ""})` : ""}`);

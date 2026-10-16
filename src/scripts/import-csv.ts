/**
 * Import a Google Takeout "Saved" CSV for one person.
 *   npm run import-csv -- <file.csv> <Advait|Emily> [list name]
 * Resolves each row with the Places API when GOOGLE_MAPS_API_KEY is set.
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
const result = await importSavedList(csv, listName ?? path.basename(file, ".csv"), person, Boolean(config.google.mapsKey));
console.log(`Imported ${result.imported} places for ${person}${config.google.mapsKey ? `, resolved ${result.resolved}` : " (no GOOGLE_MAPS_API_KEY: stored unresolved)"}.`);
if (result.unresolved.length) console.log(`Unresolved: ${result.unresolved.join(", ")}`);

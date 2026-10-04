import { google } from "googleapis";
import { config, PEOPLE } from "../config";
import { kvGet, kvSet } from "../db";
import { clientFor } from "../google/auth";
import { say } from "../notify";
import { csvsFromTakeoutZip, importSavedList } from "../places/takeout";

/**
 * Picks up Google Takeout exports ("Saved" product, delivered to Drive) for
 * each person and imports every saved list in them.
 */
export async function takeoutWatch(): Promise<void> {
  for (const person of PEOPLE) {
    const auth = clientFor(person);
    if (!auth) continue;
    const drive = google.drive({ version: "v3", auth });
    const seen = new Set(kvGet<string[]>(`takeout_seen:${person}`, []));
    const list = await drive.files.list({
      q: "name contains 'takeout-' and mimeType = 'application/zip' and trashed = false",
      orderBy: "createdTime desc",
      pageSize: 5,
      fields: "files(id, name, createdTime)",
    });
    for (const f of list.data.files ?? []) {
      if (!f.id || seen.has(f.id)) continue;
      const res = await drive.files.get({ fileId: f.id, alt: "media" }, { responseType: "arraybuffer" });
      const csvs = await csvsFromTakeoutZip(Buffer.from(res.data as ArrayBuffer));
      let total = 0;
      for (const [listName, csv] of Object.entries(csvs)) {
        const r = await importSavedList(csv, listName, person, Boolean(config.google.mapsKey));
        total += r.imported;
      }
      seen.add(f.id);
      kvSet(`takeout_seen:${person}`, [...seen]);
      if (total) await say(`📍 Imported ${total} saved places from ${person}'s Google Maps lists (${Object.keys(csvs).join(", ")}).`);
    }
  }
}

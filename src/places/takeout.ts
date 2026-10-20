import { parse } from "csv-parse/sync";
import JSZip from "jszip";
import { db } from "../db";
import { getPrefs, upsertPlace } from "../db/repo";
import { NOT_DINNER_TYPES } from "../recommender/filters";
import { estimateTravelMin } from "../util/geo";
import { cidFromMapsUri, cuisineFromTypes, placeLite, searchIds, type GPlace } from "./google";

export interface SavedRow {
  title: string;
  note: string | null;
  url: string;
  /** Decimal CID from the URL's feature id (0x...:0x<cid>), the stable Maps id. */
  cid: string | null;
}

/** Parse one Google Takeout "Saved" list CSV (Title, Note, URL, Tags, Comment). */
export function parseSavedCsv(csv: string): SavedRow[] {
  const records = parse(csv, { columns: true, skip_empty_lines: true, bom: true, relax_column_count: true }) as Record<string, string>[];
  const rows: SavedRow[] = [];
  for (const r of records) {
    const title = (r.Title ?? "").trim();
    const url = (r.URL ?? "").trim();
    if (!title || !url) continue;
    rows.push({ title, note: (r.Note ?? "").trim() || null, url, cid: cidFromSavedUrl(url) });
  }
  return rows;
}

export function cidFromSavedUrl(url: string): string | null {
  const ftid = url.match(/!1s0x[0-9a-f]+:(0x[0-9a-f]+)/i)?.[1];
  if (ftid) return BigInt(ftid).toString();
  return cidFromMapsUri(url);
}

/** Pull every Saved/*.csv out of a Takeout zip, keyed by list name. */
export async function csvsFromTakeoutZip(buf: Buffer): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(buf);
  const out: Record<string, string> = {};
  for (const [name, file] of Object.entries(zip.files)) {
    const m = name.match(/Saved\/([^/]+)\.csv$/);
    if (m && !file.dir) out[m[1]] = await file.async("string");
  }
  return out;
}

const TOKYO = { lat: 35.6762, lng: 139.7003 };

/** Places a dinner date could happen at: restaurants and bars, not cafés, shops or hotels. */
export function isDinnerType(primaryType: string | null | undefined, types: string[] = []): boolean {
  if (primaryType && NOT_DINNER_TYPES.has(primaryType)) return false;
  const all = [primaryType ?? "", ...types];
  return all.some((t) => t === "restaurant" || t.endsWith("_restaurant") || t === "bar" || t.endsWith("_bar") || t === "pub" || t === "izakaya");
}

export interface ImportResult {
  /** Rows in the file. */
  rows: number;
  /** Added or updated (dinner places within reach, or all rows without a Maps key). */
  imported: number;
  /** Already known (e.g. on the other person's list): marked as saved by this person too. */
  alreadyKnown: number;
  skipped: { notDinner: string[]; tooFar: string[]; closed: string[] };
  unresolved: string[];
}

/**
 * Import a saved list for one person. With `resolve` (a Maps key), each new row
 * gets two cheap lookups (see places/google.ts searchIds/placeLite); only dinner
 * places within reach of home or work are kept. Their full details are fetched
 * when they first come up as candidates. Without `resolve` rows are stored by CID.
 */
export async function importSavedList(csv: string, listName: string, person: string, resolve: boolean, onProgress?: (done: number, total: number) => void): Promise<ImportResult> {
  const rows = parseSavedCsv(csv);
  const result: ImportResult = { rows: rows.length, imported: 0, alreadyKnown: 0, skipped: { notDinner: [], tooFar: [], closed: [] }, unresolved: [] };
  const prefs = getPrefs();
  const anchors = [prefs.anchors.home, prefs.anchors.office].filter(Boolean);
  const reach = prefs.maxTravelMin + 30;
  let done = 0;
  for (const row of rows) {
    onProgress?.(++done, rows.length);
    const known = row.cid ? (db().prepare("SELECT id FROM places WHERE cid = ?").get(row.cid) as { id: number } | undefined) : undefined;
    if (known) {
      upsertPlace({ cid: row.cid, name: row.title, source: `takeout:${listName}`, saved_by: [person] });
      result.alreadyKnown++;
      continue;
    }
    if (!resolve) {
      upsertPlace({ cid: row.cid, name: row.title, maps_url: row.url, note: row.note, source: `takeout:${listName}`, saved_by: [person] });
      result.imported++;
      continue;
    }
    let hit: GPlace | undefined;
    try {
      for (const id of await searchIds(row.title, TOKYO)) {
        const g = await placeLite(id);
        hit ??= g;
        if (row.cid && cidFromMapsUri(g.googleMapsUri) === row.cid) {
          hit = g;
          break;
        }
      }
    } catch (err) {
      console.warn(`lookup failed for ${row.title}:`, (err as Error).message);
    }
    if (!hit?.location) {
      result.unresolved.push(row.title);
      continue;
    }
    if (hit.businessStatus === "CLOSED_PERMANENTLY") {
      result.skipped.closed.push(row.title);
      continue;
    }
    if (!isDinnerType(hit.primaryType, hit.types)) {
      result.skipped.notDinner.push(row.title);
      continue;
    }
    const loc = { lat: hit.location.latitude, lng: hit.location.longitude };
    if (Math.min(...anchors.map((a) => estimateTravelMin(a, loc))) > reach) {
      result.skipped.tooFar.push(row.title);
      continue;
    }
    // No google_place_id on purpose: candidates.ts enrich() fetches the full details the first time it's near a date.
    upsertPlace({
      cid: row.cid ?? cidFromMapsUri(hit.googleMapsUri),
      name: row.title,
      address: hit.formattedAddress ?? null,
      lat: loc.lat,
      lng: loc.lng,
      primary_type: hit.primaryType ?? null,
      types: hit.types ?? [],
      cuisine: cuisineFromTypes(hit.primaryType, hit.types),
      maps_url: hit.googleMapsUri ?? row.url,
      note: row.note,
      source: `takeout:${listName}`,
      saved_by: [person],
    });
    result.imported++;
  }
  return result;
}

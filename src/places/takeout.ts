import { parse } from "csv-parse/sync";
import JSZip from "jszip";
import { upsertPlace } from "../db/repo";
import type { Place } from "../types";
import { cidFromMapsUri, textSearch, toPlaceFields } from "./google";

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

/**
 * Find the Places API id for a saved row. Text search by title, then prefer the
 * result whose CID matches the saved URL exactly.
 */
export async function resolveSavedRow(row: SavedRow): Promise<Partial<Place> | null> {
  const results = await textSearch(`${row.title} Tokyo`, TOKYO, 30000, 5);
  const exact = row.cid ? results.find((r) => cidFromMapsUri(r.googleMapsUri) === row.cid) : undefined;
  const hit = exact ?? results[0];
  if (!hit) return null;
  return toPlaceFields(hit);
}

export interface ImportResult {
  imported: number;
  resolved: number;
  unresolved: string[];
}

/**
 * Import a saved list for one person. With `resolve` the rows are enriched via
 * the Places API; without it (no API key yet) they are stored by CID and
 * resolved later.
 */
export async function importSavedList(csv: string, listName: string, person: string, resolve: boolean): Promise<ImportResult> {
  const rows = parseSavedCsv(csv);
  const result: ImportResult = { imported: 0, resolved: 0, unresolved: [] };
  for (const row of rows) {
    let fields: Partial<Place> | null = null;
    if (resolve) {
      try {
        fields = await resolveSavedRow(row);
      } catch (err) {
        console.warn(`resolve failed for ${row.title}:`, (err as Error).message);
      }
      if (fields) result.resolved++;
      else result.unresolved.push(row.title);
    }
    upsertPlace({
      ...fields,
      cid: fields?.cid ?? row.cid,
      name: fields?.name ?? row.title,
      maps_url: fields?.maps_url ?? row.url,
      note: row.note,
      source: `takeout:${listName}`,
      saved_by: [person],
    });
    result.imported++;
  }
  return result;
}

import { DEFAULT_ANCHORS } from "../config";
import type { Place, Plan, Prefs, Reservation } from "../types";
import { db, kvGet, kvSet } from "./index";

// ---------- prefs ----------

export const DEFAULT_PREFS: Prefs = {
  anchors: { home: DEFAULT_ANCHORS.home, office: DEFAULT_ANCHORS.office },
  defaultWeekday: 3,
  defaultTime: "18:30",
  partySize: 2,
  kickoff: { weekday: 6, time: "10:00" },
  nudge: { weekday: 7, time: "10:00" },
  decideBy: { weekday: 7, time: "20:00" },
  maxTravelMin: 25,
  cuisineCooldownDates: 3,
  revisitCooldownWeeks: 8,
  budgetPerPersonMaxJpy: 15000,
  dietary: "",
  autoCancel: false,
  skipWeeks: [],
};

export function getPrefs(): Prefs {
  return { ...DEFAULT_PREFS, ...kvGet<Partial<Prefs>>("prefs", {}) };
}

export function updatePrefs(patch: Partial<Prefs>): Prefs {
  const next = { ...getPrefs(), ...patch };
  kvSet("prefs", next);
  return next;
}

// ---------- places ----------

const JSON_PLACE_FIELDS = ["types", "opening_periods", "profile", "saved_by"] as const;

function rowToPlace(row: Record<string, unknown>): Place {
  const p = { ...row } as Record<string, unknown>;
  for (const f of JSON_PLACE_FIELDS) p[f] = p[f] == null ? (f === "types" || f === "saved_by" ? [] : null) : JSON.parse(p[f] as string);
  p.reservable = p.reservable == null ? null : Boolean(p.reservable);
  return p as unknown as Place;
}

function placeToRow(p: Partial<Place>): Record<string, unknown> {
  const row: Record<string, unknown> = { ...p };
  for (const f of JSON_PLACE_FIELDS) if (f in row) row[f] = row[f] == null ? null : JSON.stringify(row[f]);
  if ("reservable" in row) row.reservable = row.reservable == null ? null : row.reservable ? 1 : 0;
  delete row.id;
  return row;
}

export function getPlace(id: number): Place | undefined {
  const row = db().prepare("SELECT * FROM places WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? rowToPlace(row) : undefined;
}

export function findPlaceByName(name: string): Place | undefined {
  const row = db()
    .prepare("SELECT * FROM places WHERE name = ? COLLATE NOCASE OR name LIKE ? ORDER BY length(name) LIMIT 1")
    .get(name, `%${name}%`) as Record<string, unknown> | undefined;
  return row ? rowToPlace(row) : undefined;
}

export function listPlaces(where = "1=1", ...params: unknown[]): Place[] {
  return (db().prepare(`SELECT * FROM places WHERE ${where}`).all(...params) as Record<string, unknown>[]).map(rowToPlace);
}

export function insertPlace(p: Partial<Place> & { name: string; source: string }): Place {
  const row = placeToRow(p);
  const cols = Object.keys(row);
  const info = db()
    .prepare(`INSERT INTO places (${cols.join(",")}) VALUES (${cols.map((c) => "@" + c).join(",")})`)
    .run(row);
  return getPlace(Number(info.lastInsertRowid))!;
}

export function updatePlace(id: number, patch: Partial<Place>): Place {
  const row = placeToRow(patch);
  const cols = Object.keys(row);
  if (cols.length) {
    db()
      .prepare(`UPDATE places SET ${cols.map((c) => `${c} = @${c}`).join(", ")} WHERE id = @id`)
      .run({ ...row, id });
  }
  return getPlace(id)!;
}

/**
 * Insert or merge a place, matching on google_place_id or cid. Merges saved_by
 * so a place on both people's lists is one row with both names.
 */
export function upsertPlace(p: Partial<Place> & { name: string; source: string }): Place {
  let existing: Place | undefined;
  if (p.google_place_id) {
    const row = db().prepare("SELECT * FROM places WHERE google_place_id = ?").get(p.google_place_id) as Record<string, unknown> | undefined;
    if (row) existing = rowToPlace(row);
  }
  if (!existing && p.cid) {
    const row = db().prepare("SELECT * FROM places WHERE cid = ?").get(p.cid) as Record<string, unknown> | undefined;
    if (row) existing = rowToPlace(row);
  }
  if (!existing) return insertPlace(p);

  const savedBy = [...new Set([...existing.saved_by, ...(p.saved_by ?? [])])];
  const patch: Partial<Place> = { saved_by: savedBy };
  for (const [k, v] of Object.entries(p)) {
    if (k === "saved_by" || k === "source" || v == null) continue;
    (patch as Record<string, unknown>)[k] = v;
  }
  // A saved-list source wins over "discovered".
  if (existing.source === "discovered" && p.source !== "discovered") patch.source = p.source;
  return updatePlace(existing.id, patch);
}

// ---------- visits ----------

export interface Visit {
  id: number;
  place_id: number;
  date: string;
  cuisine: string | null;
  rating: number | null;
}

export function recentVisits(limit = 20): Visit[] {
  return db().prepare("SELECT * FROM visits ORDER BY date DESC LIMIT ?").all(limit) as Visit[];
}

export function addVisit(placeId: number, date: string, cuisine: string | null): void {
  db().prepare("INSERT INTO visits (place_id, date, cuisine) VALUES (?, ?, ?)").run(placeId, date, cuisine);
}

// ---------- plans ----------

function rowToPlan(row: Record<string, unknown>): Plan {
  return { ...row, options: JSON.parse(row.options as string), votes: JSON.parse(row.votes as string) } as Plan;
}

export function createPlan(p: Pick<Plan, "date" | "time" | "party_size" | "status" | "request" | "options">): Plan {
  const info = db()
    .prepare("INSERT INTO plans (date, time, party_size, status, request, options) VALUES (?, ?, ?, ?, ?, ?)")
    .run(p.date, p.time, p.party_size, p.status, p.request, JSON.stringify(p.options));
  return getPlan(Number(info.lastInsertRowid))!;
}

export function getPlan(id: number): Plan | undefined {
  const row = db().prepare("SELECT * FROM plans WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? rowToPlan(row) : undefined;
}

export function getPlanByPoll(pollMsgId: string): Plan | undefined {
  const row = db().prepare("SELECT * FROM plans WHERE poll_msg_id = ?").get(pollMsgId) as Record<string, unknown> | undefined;
  return row ? rowToPlan(row) : undefined;
}

/** The newest plan for a date that hasn't been cancelled. */
export function activePlanFor(date: string): Plan | undefined {
  const row = db()
    .prepare("SELECT * FROM plans WHERE date = ? AND status != 'cancelled' ORDER BY id DESC LIMIT 1")
    .get(date) as Record<string, unknown> | undefined;
  return row ? rowToPlan(row) : undefined;
}

export function updatePlan(id: number, patch: Partial<Plan>): Plan {
  const row: Record<string, unknown> = { ...patch };
  if (row.options) row.options = JSON.stringify(row.options);
  if (row.votes) row.votes = JSON.stringify(row.votes);
  delete row.id;
  const cols = Object.keys(row);
  if (cols.length) db().prepare(`UPDATE plans SET ${cols.map((c) => `${c} = @${c}`).join(", ")} WHERE id = @id`).run({ ...row, id });
  return getPlan(id)!;
}

// ---------- reservations ----------

export function createReservation(r: Omit<Reservation, "id" | "last_seen_message_id"> & { last_seen_message_id?: string | null }): Reservation {
  const row = { last_seen_message_id: null, ...r };
  const cols = Object.keys(row);
  const info = db()
    .prepare(`INSERT INTO reservations (${cols.join(",")}) VALUES (${cols.map((c) => "@" + c).join(",")})`)
    .run(row);
  return getReservation(Number(info.lastInsertRowid))!;
}

export function getReservation(id: number): Reservation | undefined {
  return db().prepare("SELECT * FROM reservations WHERE id = ?").get(id) as Reservation | undefined;
}

export function updateReservation(id: number, patch: Partial<Reservation>): Reservation {
  const row: Record<string, unknown> = { ...patch };
  delete row.id;
  const cols = Object.keys(row);
  if (cols.length) {
    db()
      .prepare(`UPDATE reservations SET ${cols.map((c) => `${c} = @${c}`).join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = @id`)
      .run({ ...row, id });
  }
  return getReservation(id)!;
}

export function upcomingReservations(fromDate: string): Reservation[] {
  return db()
    .prepare("SELECT * FROM reservations WHERE date >= ? AND status IN ('requested','confirmed') ORDER BY date, time")
    .all(fromDate) as Reservation[];
}

// ---------- users & chat log ----------

export interface User {
  id: number;
  name: string;
  wa_jid: string | null;
  email: string | null;
  google_tokens: string | null;
}

export function getUser(name: string): User | undefined {
  return db().prepare("SELECT * FROM users WHERE name = ?").get(name) as User | undefined;
}

export function upsertUser(name: string, patch: Partial<Omit<User, "id" | "name">>): User {
  db().prepare("INSERT INTO users (name) VALUES (?) ON CONFLICT(name) DO NOTHING").run(name);
  const cols = Object.keys(patch);
  if (cols.length) db().prepare(`UPDATE users SET ${cols.map((c) => `${c} = @${c}`).join(", ")} WHERE name = @name`).run({ ...patch, name });
  return getUser(name)!;
}

export function userByJid(jid: string): User | undefined {
  return db().prepare("SELECT * FROM users WHERE wa_jid = ?").get(jid) as User | undefined;
}

export function logMessage(sender: string, text: string, waMsgId?: string): void {
  db().prepare("INSERT INTO messages (sender, text, wa_msg_id) VALUES (?, ?, ?)").run(sender, text, waMsgId ?? null);
}

export function recentMessages(limit = 30): { at: string; sender: string; text: string }[] {
  const rows = db().prepare("SELECT at, sender, text FROM messages ORDER BY id DESC LIMIT ?").all(limit) as {
    at: string;
    sender: string;
    text: string;
  }[];
  return rows.reverse();
}

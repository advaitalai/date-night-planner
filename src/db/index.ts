import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  wa_jid TEXT,
  email TEXT,
  google_tokens TEXT
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS places (
  id INTEGER PRIMARY KEY,
  google_place_id TEXT UNIQUE,
  cid TEXT UNIQUE,
  name TEXT NOT NULL,
  address TEXT,
  lat REAL,
  lng REAL,
  primary_type TEXT,
  types TEXT,
  cuisine TEXT,
  price_level INTEGER,
  rating REAL,
  rating_count INTEGER,
  tabelog_score REAL,
  phone TEXT,
  website TEXT,
  maps_url TEXT,
  opening_periods TEXT,
  reservable INTEGER,
  booking_channel TEXT NOT NULL DEFAULT 'unknown',
  tablecheck_slug TEXT,
  tabelog_url TEXT,
  booking_email TEXT,
  booking_url TEXT,
  profile TEXT,
  source TEXT NOT NULL,
  saved_by TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  details_fetched_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY,
  place_id INTEGER NOT NULL REFERENCES places(id),
  date TEXT NOT NULL,
  cuisine TEXT,
  rating INTEGER,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  party_size INTEGER NOT NULL DEFAULT 2,
  status TEXT NOT NULL,
  request TEXT,
  options TEXT NOT NULL DEFAULT '[]',
  poll_msg_id TEXT,
  votes TEXT NOT NULL DEFAULT '{}',
  chosen_place_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER REFERENCES plans(id),
  place_id INTEGER NOT NULL REFERENCES places(id),
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  party_size INTEGER NOT NULL,
  external_ref TEXT,
  manage_url TEXT,
  gmail_thread_id TEXT,
  last_seen_message_id TEXT,
  policy_text TEXT,
  free_cancel_deadline TEXT,
  cancel_fee TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  run_at TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  dedupe_key TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status, run_at);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sender TEXT NOT NULL,
  text TEXT NOT NULL,
  wa_msg_id TEXT
);
`;

let instance: Database.Database | undefined;

export function openDb(file = path.join(config.dataDir, "planner.db")): Database.Database {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

export function db(): Database.Database {
  instance ??= openDb();
  return instance;
}

/** Swap the shared connection (tests use an in-memory database). */
export function setDb(next: Database.Database): void {
  instance = next;
}

export function kvGet<T>(key: string, fallback: T): T {
  const row = db().prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : fallback;
}

export function kvSet(key: string, value: unknown): void {
  db()
    .prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, JSON.stringify(value));
}

/** The test bot's nightly copy of the live data (7 Nov). */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { snapshotForTest } from "../src/db/snapshot";

describe("test bot data copy", () => {
  it("copies places and preferences, leaves out chats, logs, reminders and a pending call, and never touches live", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-"));
    const liveFile = path.join(dir, "live.db");
    const live = openDb(liveFile);
    live.prepare("INSERT INTO places (name, source) VALUES ('cado', 'saved')").run();
    live.prepare("INSERT INTO kv (key, value) VALUES ('prefs', '{}'), ('pending_call', '{}')").run();
    live.prepare("INSERT INTO messages (sender, text) VALUES ('Emily', 'babe which one')").run();
    live.prepare("INSERT INTO jobs (type, run_at, payload, dedupe_key) VALUES ('dayof_reminder', '2026-11-11T02:00:00Z', '{}', 'd1')").run();
    const count = (d: Database.Database, t: string) => (d.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;

    await snapshotForTest(liveFile, path.join(dir, "test.db"));
    const copy = new Database(path.join(dir, "test.db"), { readonly: true });
    expect(count(copy, "places")).toBe(1);
    expect(copy.prepare("SELECT key FROM kv").all()).toEqual([{ key: "prefs" }]);
    expect(count(copy, "messages")).toBe(0);
    expect(count(copy, "jobs")).toBe(0);
    copy.close();
    // Live is untouched.
    expect(count(live, "messages")).toBe(1);
    expect(count(live, "jobs")).toBe(1);
    live.close();
  });
});

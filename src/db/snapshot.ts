import Database from "better-sqlite3";

/**
 * Copy the live bot's database for the test bot (deploy/sync-test-data.sh).
 * A SQLite backup, so it's consistent even while the live bot is writing.
 * Data only flows live → test. Left out of the copy: the chat history, the
 * call and booking logs (so the test bot can't see or quote your chats), the
 * scheduled reminders (they'd post "Tonight 🥂" in the test group) and a
 * pending call.
 */
export async function snapshotForTest(fromFile: string, toFile: string): Promise<void> {
  const live = new Database(fromFile, { readonly: true });
  try {
    await live.backup(toFile);
  } finally {
    live.close();
  }
  const copy = new Database(toFile);
  try {
    copy.exec("DELETE FROM messages; DELETE FROM jobs; DELETE FROM call_log; DELETE FROM booking_log; DELETE FROM kv WHERE key = 'pending_call';");
    copy.pragma("journal_mode = DELETE"); // one self-contained file to move into place
  } finally {
    copy.close();
  }
}

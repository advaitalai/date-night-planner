/**
 * Clear test leftovers before real use, keeping places, visits and bookings:
 *
 *   npm run fresh-start
 *
 * - closes open proposals (old dry-run options)
 * - drops any call waiting for a go-ahead
 * - clears the chat history the bot reads for context
 * - cancels leftover jobs from removed features (scheduled calls, weekly trigger)
 * - marks phone bookings made before go-live as cancelled in the database: no real
 *   restaurant call had been made yet, so they're all dry-run mocks (nothing is called)
 *
 * Run it with the bot stopped.
 */
import { db, kvSet } from "../db";

const d = db();
const plans = d.prepare("UPDATE plans SET status = 'cancelled' WHERE status IN ('proposed', 'booking')").run().changes;
kvSet("pending_call", null);
const msgs = d.prepare("DELETE FROM messages").run().changes;
const jobs = d.prepare("UPDATE jobs SET status = 'cancelled' WHERE status = 'pending' AND type IN ('phone_call', 'kickoff', 'nudge', 'decide') /* old job types, kept so leftovers are cleared */").run().changes;
const mocks = d.prepare("SELECT r.id, p.name, r.date, r.time FROM reservations r JOIN places p ON p.id = r.place_id WHERE r.channel = 'phone' AND r.status IN ('confirmed', 'requested')").all() as { id: number; name: string; date: string; time: string }[];
for (const m of mocks) {
  d.prepare("UPDATE reservations SET status = 'cancelled', notes = COALESCE(notes, '') || ' / dry-run mock, cleared by fresh-start' WHERE id = ?").run(m.id);
  d.prepare("UPDATE jobs SET status = 'cancelled' WHERE status = 'pending' AND dedupe_key LIKE ?").run(`res:${m.id}:%`);
}
const live = d.prepare("SELECT COUNT(*) AS n FROM reservations WHERE status IN ('confirmed', 'requested')").get() as { n: number };

console.log(`Closed ${plans} open proposal(s).`);
console.log(`Cleared ${msgs} chat message(s) from the bot's memory and any pending call.`);
console.log(`Cancelled ${jobs} pending scheduled job(s); weekly reminders are set up again on start.`);
console.log(`Cleared ${mocks.length} dry-run phone booking(s)${mocks.length ? `: ${mocks.map((m) => `${m.name} ${m.date} ${m.time}`).join(", ")}` : ""} (database only, no calls).`);
console.log(`Kept: places, visits, and ${live.n} active booking(s). Check them with "what's booked?" in the chat.`);

/**
 * What happened, for debugging:
 *
 *   npm run logs                 last 10 calls and booking attempts
 *   npm run logs -- call <id>    one call in full (transcript, recording link)
 *
 * Terminal output is also kept in data/logs/<day>.log.
 */
import { db } from "../db";

type Row = Record<string, unknown>;
const [cmd, id] = process.argv.slice(2);

if (cmd === "call" && id) {
  const c = db().prepare("SELECT * FROM call_log WHERE id = ?").get(Number(id)) as Row | undefined;
  if (!c) {
    console.log(`No call #${id}.`);
  } else {
    console.log(`Call #${c.id}  ${c.at} UTC  ${c.kind} ${c.place_name}${c.dry_run ? " (dry run)" : ""}`);
    console.log(`To ${c.to_number}  ·  ${c.outcome}  ·  ${c.duration_sec ?? "?"} s  ·  $${c.cost_usd ?? "?"}  ·  ended: ${c.ended_reason ?? "?"}`);
    console.log(`Summary: ${c.summary}`);
    if (c.recording_url) console.log(`Recording: ${c.recording_url}`);
    console.log(`\nTranscript:\n${c.transcript ?? "(none)"}`);
  }
} else {
  const calls = db().prepare("SELECT id, at, kind, place_name, outcome, duration_sec, cost_usd, summary, dry_run FROM call_log ORDER BY id DESC LIMIT 10").all() as Row[];
  console.log("Calls (newest first; `npm run logs -- call <id>` for the transcript)");
  for (const c of calls) console.log(`  #${c.id} ${c.at}  ${c.kind} ${c.place_name}  ${c.outcome}  ${c.duration_sec ?? "?"}s $${c.cost_usd ?? "?"}${c.dry_run ? "  [dry run]" : ""}\n      ${c.summary}`);
  if (!calls.length) console.log("  none yet");
  const tries = db().prepare("SELECT * FROM booking_log ORDER BY id DESC LIMIT 10").all() as Row[];
  console.log("\nBooking attempts (newest first)");
  for (const t of tries) console.log(`  ${t.at}  ${t.place_name} ${t.date} ${t.time} via ${t.channel}: ${t.result}${t.dry_run ? "  [dry run]" : ""}\n      ${String(t.detail ?? "").split("\n")[0].slice(0, 160)}`);
  if (!tries.length) console.log("  none yet");
}

/**
 * A week-in-review of how the bot performed, from its database and log files:
 *
 *   npm run retro                     last 7 days
 *   npm run retro -- 2026-10-09       since a date
 *
 * Writes data/retro.md (and prints it). Phone numbers are masked, so it's safe
 * to paste into a chat. Message texts are included (they're your group chat).
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import { db } from "../db";

const since = process.argv[2] ?? new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
const d = db();
type Row = Record<string, unknown>;
const all = (sql: string, ...p: unknown[]) => d.prepare(sql).all(...p) as Row[];
const mask = (s: unknown) => String(s ?? "").replace(/\+?\d[\d\s-]{7,}\d/g, (m) => `${m.slice(0, 3)}…${m.slice(-2)}`);
const out: string[] = [];
const line = (s = "") => out.push(s);

line(`# Bot retro since ${since}`);
line();

// ---------- conversation ----------
const msgs = all("SELECT at, sender, text FROM messages WHERE at >= ? ORDER BY id", since);
const bySender = new Map<string, number>();
for (const m of msgs) bySender.set(String(m.sender), (bySender.get(String(m.sender)) ?? 0) + 1);
line("## Conversation");
line(`- Messages: ${msgs.length} (${[...bySender].map(([s, n]) => `${s} ${n}`).join(", ") || "none"})`);
line();
line("<details><summary>Full chat (UTC)</summary>");
line();
for (const m of msgs) line(`- \`${String(m.at).slice(5, 16)}\` **${m.sender}**: ${mask(m.text).replace(/\n+/g, " ⏎ ").slice(0, 400)}`);
line();
line("</details>");
line();

// ---------- plans ----------
const plans = all("SELECT id, date, time, status, request, options, votes, created_at FROM plans WHERE created_at >= ? ORDER BY id", since);
line("## Proposals");
line(`- ${plans.length} proposal(s)`);
for (const p of plans) {
  const opts = (JSON.parse(String(p.options)) as { name: string }[]).map((o) => o.name).join(" / ");
  line(`- #${p.id} for ${p.date} ${p.time} (${p.status})${p.request ? ` "${String(p.request).slice(0, 80)}"` : ""}: ${opts}; picks ${p.votes}`);
}
line();

// ---------- bookings ----------
const res = all(
  "SELECT r.id, p.name, r.date, r.time, r.party_size, r.channel, r.status, r.free_cancel_deadline, r.created_at FROM reservations r JOIN places p ON p.id = r.place_id WHERE r.created_at >= ? ORDER BY r.id",
  since,
);
line("## Bookings");
for (const r of res) line(`- #${r.id} ${r.name} ${r.date} ${r.time} for ${r.party_size}, ${r.channel}: **${r.status}** (free cancel until ${r.free_cancel_deadline ?? "?"})`);
if (!res.length) line("- none");
const attempts = all("SELECT at, place_name, date, time, channel, result, detail, dry_run FROM booking_log WHERE at >= ? ORDER BY id", since);
line();
line(`Booking attempts: ${attempts.length}`);
for (const a of attempts) line(`- \`${String(a.at).slice(5, 16)}\` ${a.place_name} ${a.date} ${a.time} via ${a.channel}: ${a.result}${a.dry_run ? " (dry run)" : ""}. ${mask(a.detail).split("\n")[0].slice(0, 140)}`);
line();

// ---------- calls ----------
const calls = all("SELECT at, place_name, kind, outcome, duration_sec, cost_usd, summary, dry_run FROM call_log WHERE at >= ? ORDER BY id", since);
const mins = calls.reduce((s, c) => s + Number(c.duration_sec ?? 0), 0) / 60;
const cost = calls.reduce((s, c) => s + Number(c.cost_usd ?? 0), 0);
line("## Phone calls");
line(`- ${calls.length} call(s), ${mins.toFixed(1)} min, Vapi cost $${cost.toFixed(2)}`);
for (const c of calls) line(`- \`${String(c.at).slice(5, 16)}\` ${c.kind} ${c.place_name}${c.dry_run ? " (dry run)" : ""}: **${c.outcome}**, ${c.duration_sec ?? "?"}s. ${mask(c.summary).slice(0, 200)}`);
line();

// ---------- reminders / jobs ----------
const jobs = all("SELECT type, status, COUNT(*) AS n FROM jobs WHERE run_at >= ? GROUP BY type, status ORDER BY type", since);
const failed = all("SELECT type, run_at, last_error FROM jobs WHERE status = 'failed' AND run_at >= ?", since);
line("## Scheduled jobs (reminders, kickoff, calls)");
for (const j of jobs) line(`- ${j.type}: ${j.n} ${j.status}`);
for (const f of failed) line(`- ❌ ${f.type} at ${f.run_at}: ${String(f.last_error ?? "").split("\n")[0].slice(0, 160)}`);
line();

// ---------- errors from the log files ----------
const logDir = path.join(config.dataDir, "logs");
const counts: Record<string, number> = {};
const samples: Record<string, string> = {};
const PATTERNS: [string, RegExp][] = [
  ["agent errors", /agent error/i],
  ["unhandled errors", /unhandled error/i],
  ["skipped messages", /\[skip\]/],
  ["undecryptable messages", /couldn't be decrypted/],
  ["WhatsApp reconnects", /WhatsApp connected as/],
  ["timeouts", /Timed Out|took too long/i],
  ["booking failures", /\[booking\].*failed/],
  ["TableCheck form refusals", /\[tablecheck\] form not accepted/],
];
if (fs.existsSync(logDir)) {
  for (const f of fs.readdirSync(logDir).filter((f) => f.slice(0, 10) >= since).sort()) {
    for (const l of fs.readFileSync(path.join(logDir, f), "utf8").split("\n")) {
      for (const [name, re] of PATTERNS) {
        if (re.test(l)) {
          counts[name] = (counts[name] ?? 0) + 1;
          samples[name] ??= mask(l).slice(0, 220);
        }
      }
    }
  }
}
// The chat as the log files saw it (the database's chat history is cleared by fresh-start).
const convo: string[] = [];
if (fs.existsSync(logDir)) {
  for (const f of fs.readdirSync(logDir).filter((f) => f.slice(0, 10) >= since).sort()) {
    for (const l of fs.readFileSync(path.join(logDir, f), "utf8").split("\n")) {
      const m = l.match(/^(\S+) \w+ \[(in|out|status|skip)\] (.*)$/);
      if (m) convo.push(`- \`${m[1].slice(5, 16)}\` ${m[2] === "in" ? "➡️" : m[2] === "out" ? "🤖" : m[2] === "skip" ? "⏭️" : "⏳"} ${mask(m[3]).slice(0, 300)}`);
    }
  }
}
line("## Chat timeline from the log files");
line(`- ${convo.filter((c) => c.includes("➡️")).length} messages in, ${convo.filter((c) => c.includes("🤖")).length} replies out`);
line();
line("<details><summary>Timeline (UTC)</summary>");
line();
for (const c of convo) line(c);
line();
line("</details>");
line();

line("## Problems in the logs");
if (!Object.keys(counts).length) line("- none found (or no log files yet)");
for (const [name] of PATTERNS) if (counts[name]) line(`- ${name}: ${counts[name]} (e.g. \`${samples[name]}\`)`);
line();

const report = out.join("\n");
fs.writeFileSync(path.join(config.dataDir, "retro.md"), report);
console.log(report);
console.log(`\nSaved to ${path.join(config.dataDir, "retro.md")}`);

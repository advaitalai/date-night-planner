/**
 * P0 launch-blocker tests (docs/P0_TESTS.md), end to end without WhatsApp:
 * messages go to handleMessage as if typed in the group, the bot's posts are
 * captured, phone calls are faked (CALL_FAKE) and TableCheck runs for real in
 * DRY_RUN (stops before the final confirm). Data lives in data/p0, never in
 * the real database.
 *
 *   npm run p0                  all, through the agent (needs ANTHROPIC_API_KEY)
 *   npm run p0 -- P0-2 P0-5     only some
 *   npm run p0 -- --tools       no LLM: the same steps, calling the tools the agent
 *                               should call (checks the booking rules, not the model)
 */
import fs from "node:fs";
import path from "node:path";

// Safety first: forced before config loads (dotenv never overrides these).
process.env.DRY_RUN = "1";
process.env.DATA_DIR = path.resolve(process.env.P0_DATA_DIR || "data/p0");
process.env.WA_SOLO = "1";
process.env.WA_POLLS = "0";
process.env.BOOKING_ONLY = "";
process.env.CALL_FAKE = "booked";
process.env.TWILIO_ACCOUNT_SID = "";
// TableCheck rejects obviously fake numbers ("Phone is invalid"), so use a valid-looking one.
process.env.BOOKING_PHONE ||= "090-1234-5678";
process.env.BOOKING_NAME ||= "Test Guest";
process.env.BOOKING_EMAIL ||= "p0-test@example.com";

const args = process.argv.slice(2);
const TOOLS_ONLY = args.includes("--tools");
const only = args.filter((a) => /^P0-\d+$/i.test(a)).map((a) => a.toUpperCase());

const { config } = await import("../config");
const { db, kvSet } = await import("../db");
const { createPlan, getPlace, getPlan, logMessage, listPlaces } = await import("../db/repo");
const { setSender } = await import("../notify");
const { tablecheck } = await import("../booking/tablecheck");
const { closeBrowsers } = await import("../booking/browser");
const { importSavedList } = await import("../places/takeout");
const { formatOptions } = await import("../recommender");
const { getPrefs } = await import("../db/repo");
const { nextWeekday, now } = await import("../util/time");
const { tools } = await import("../agent/tools");
type Place = import("../types").Place;

if (!TOOLS_ONLY && !process.env.ANTHROPIC_API_KEY && !process.env.PLANNER_ANTHROPIC_API_KEY) {
  console.error("No Anthropic key (ANTHROPIC_API_KEY, or PLANNER_ANTHROPIC_API_KEY in cloud sessions). Add it to the environment, or run `npm run p0 -- --tools` for the no-LLM checks.");
  process.exit(2);
}

// ---------- fake WhatsApp ----------

let posts: string[] = [];
setSender({
  async text(t) {
    if (!t.startsWith("⏳")) posts.push(t);
    return `m${Date.now()}`;
  },
  async poll(q) {
    posts.push(`[poll] ${q}`);
    return undefined;
  },
  async edit() {},
  async remove() {},
});

type Step = { tool: string; input: Record<string, unknown> };

/** One message in the group. In --tools mode the given tool call stands in for the agent. */
async function send(person: "Advait" | "Emily", text: string, step?: Step): Promise<string[]> {
  posts = [];
  console.log(`\n[in] ${person}: ${text}`);
  logMessage(person, text);
  if (TOOLS_ONLY) {
    if (!step) throw new Error(`no tool step for "${text}" in --tools mode`);
    const tool = tools.find((t) => t.name === step.tool)!;
    const result = await (tool.run as (i: unknown) => Promise<unknown>)(step.input);
    console.log(`[tool ${step.tool}] ${String(result).slice(0, 300)}`);
  } else {
    const { handleMessage } = await import("../agent/loop");
    const reply = await handleMessage(person, text);
    if (reply) {
      logMessage("planner", reply);
      posts.push(reply);
      console.log(`[reply] ${reply}`);
    }
  }
  return posts;
}

// ---------- state helpers ----------

const maxId = (table: string) => (db().prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${table}`).get() as { m: number }).m;
const rowsAfter = (table: string, id: number) => db().prepare(`SELECT * FROM ${table} WHERE id > ?`).all(id) as Record<string, unknown>[];

const realTc = { checkAvailability: tablecheck.checkAvailability, book: tablecheck.book };

function reset(): void {
  db().prepare("UPDATE plans SET status = 'cancelled' WHERE status IN ('proposed', 'booking')").run();
  db().prepare("DELETE FROM messages").run();
  kvSet("pending_call", null);
  Object.assign(tablecheck, realTc);
  config.wa.solo = true;
}

const wednesday = () => nextWeekday(now(), getPrefs().defaultWeekday);

/** A proposal with these places, posted to the chat as the recommender would. */
function planWith(places: Place[], time = getPrefs().defaultTime) {
  const options = places.map((p) => ({
    placeId: p.id,
    name: p.name,
    availability: "unchecked" as const,
    what: `${p.cuisine ?? p.primary_type ?? "Restaurant"} in Tokyo`,
    why: "Saved on your list",
    pitch: "",
    score: 1,
  }));
  const plan = createPlan({ date: wednesday(), time, time_latest: null, party_size: 2, status: "proposed", request: null, options });
  const text = formatOptions({
    header: `${plan.date} · ${time} · 2 people`,
    options: options.map((o) => ({ ...o, place: getPlace(o.placeId)!, travelMin: 15, anchor: "home" })),
    notes: [],
    solo: config.wa.solo,
  });
  logMessage("planner", text);
  return plan;
}

// ---------- fixtures ----------

async function ensureFixtures(): Promise<void> {
  if (listPlaces().length) return;
  console.log("Importing fixtures/Tokyo_food.csv…");
  await importSavedList(fs.readFileSync("fixtures/Tokyo_food.csv", "utf8"), "Tokyo food", "Advait", Boolean(config.google.mapsKey));
}

const phoneOnly = () => listPlaces("booking_channel = 'phone' AND tablecheck_slug IS NULL").filter((p) => !/dessert|cake|pastry|cafe/.test(p.primary_type ?? ""));
/** TableCheck places, the ones known to be bookable (seats only, supported form) first: fewer requests, fewer 403s. */
const KNOWN_GOOD = (process.env.P0_TABLECHECK || "SMOKEHOUSE,bills Omotesando").split(",").map((s) => s.trim().toLowerCase());
const rank = (p: Place) => {
  const i = KNOWN_GOOD.indexOf(p.name.toLowerCase());
  return i < 0 ? KNOWN_GOOD.length : i;
};
const tcPlaces = () => listPlaces("tablecheck_slug IS NOT NULL AND tablecheck_slug NOT LIKE '%pickup%'").sort((a, b) => rank(a) - rank(b) || a.id - b.id);

/** A TableCheck place with a free table on Wednesday (real availability API), and the time. */
let freeTc: { place: Place; time: string } | null | undefined;
async function findFreeTableCheck(): Promise<{ place: Place; time: string } | null> {
  if (freeTc !== undefined) return freeTc;
  for (const place of tcPlaces()) {
    for (const time of ["18:30", "19:00", "18:00", "19:30"]) {
      await new Promise((ok) => setTimeout(ok, 800)); // TableCheck 403s bursts of requests
      const r = await realTc.checkAvailability.call(tablecheck, place, { date: wednesday(), time, partySize: 2 }).catch(() => null);
      console.log(`[setup] ${place.name} ${time}: ${r?.status ?? "error"}${r?.detail ? ` (${r.detail})` : ""}`);
      if (r?.status === "available") return (freeTc = { place, time });
      if (r?.status === "unknown") break;
    }
  }
  return (freeTc = null);
}

// ---------- checks ----------

type Result = { id: string; pass: boolean | null; notes: string[] };
const results: Result[] = [];

function check(r: Result, ok: boolean, what: string): void {
  r.notes.push(`${ok ? "✅" : "❌"} ${what}`);
  if (!ok) r.pass = false;
}

const EM_DASH = /—/;
const DESSERT_TYPES = /dessert|cake|pastry|ice_cream|cafe|coffee|bakery|confection|donut|candy|chocolate/;

let p01PlanId: number | undefined;

const TESTS: Record<string, (r: Result) => Promise<void>> = {
  async "P0-1"(r) {
    if (TOOLS_ONLY) return void (r.pass = null, r.notes.push("needs the agent (LLM)"));
    reset();
    const out = await send("Advait", "plan wednesday");
    const cards = out.filter((m) => m.startsWith("🍷"));
    check(r, out.length === 1 && cards.length === 1, `one message (got ${out.length})`);
    const msg = cards[0] ?? "";
    const blocks = msg.split("\n\n").filter((b) => /^(1️⃣|2️⃣|3️⃣)/.test(b));
    check(r, blocks.length >= 1 && blocks.length <= 3, `1–3 cards (got ${blocks.length})`);
    blocks.forEach((b, i) => {
      check(r, /\*Why:\*/.test(b), `card ${i + 1} has a why`);
      check(r, /by train|walk/.test(b), `card ${i + 1} has area + by train/walk`);
      check(r, /📍 https?:\/\//.test(b), `card ${i + 1} has a map link`);
      const prose = b.split("\n").slice(2).filter((l) => !l.startsWith("📍")).join(" ");
      check(r, !/\d+\s*min|minutes?|km\b|book (early|ahead)|reserve (early|ahead)|booking tip/i.test(prose), `card ${i + 1} what/why has no distance or booking tips`);
    });
    const plan = db().prepare("SELECT id FROM plans WHERE status = 'proposed' ORDER BY id DESC LIMIT 1").get() as { id: number } | undefined;
    p01PlanId = plan?.id;
    const places = plan ? getPlan(plan.id)!.options.map((o) => getPlace(o.placeId)!) : [];
    check(r, places.every((p) => !DESSERT_TYPES.test(p.primary_type ?? "") && !/dessert/.test(p.cuisine ?? "")), `no dessert places (${places.map((p) => `${p.name}: ${p.primary_type}`).join(", ")})`);
    check(r, !out.some((m) => EM_DASH.test(m)), "no em dashes");
  },

  async "P0-2"(r) {
    reset();
    const free = await findFreeTableCheck();
    if (!free) return void (r.pass = null, r.notes.push("no TableCheck place with a free table on Wednesday"));
    const [a, b] = phoneOnly();
    const plan = planWith([a, free.place, b], free.time);
    const [logId, callId] = [maxId("booking_log"), maxId("call_log")];
    const out = await send("Advait", "2", { tool: "pick_option", input: { option_number: 2, person: "Advait" } });
    const booked = out.find((m) => m.includes("🧪"));
    check(r, !!booked && booked.includes(free.place.name), `"🧪 would be booked" for ${free.place.name} at ${free.time}`);
    check(r, !out.some((m) => m.includes(a.name) || m.includes(b.name)), "no other place mentioned");
    const logs = rowsAfter("booking_log", logId);
    check(r, logs.length > 0 && logs.every((l) => l.place_id === free.place.id), `booking_log only ${free.place.name} (${logs.map((l) => `${l.place_name}/${l.result}`).join(", ")})`);
    check(r, rowsAfter("call_log", callId).length === 0, "no calls");
    check(r, !out.some((m) => EM_DASH.test(m)), "no em dashes");
    void plan;
  },

  async "P0-3"(r) {
    // a) availability says full; b) availability says free but the form refuses (TableCheck gotcha).
    for (const variant of ["a", "b"] as const) {
      reset();
      const [tc] = tcPlaces();
      const [a, b] = phoneOnly();
      planWith([tc, a, b], "18:30");
      let books = 0;
      tablecheck.checkAvailability = async () => (variant === "a" ? { status: "unavailable", alternatives: ["12:00", "17:00", "20:30", "21:00"] } : { status: "available" });
      tablecheck.book = async () => {
        books++;
        return { status: "failed", full: true, alternatives: ["17:00", "20:30"], detail: "18:30 is full on TableCheck" };
      };
      const [logId, callId] = [maxId("booking_log"), maxId("call_log")];
      const out = await send("Advait", "1", { tool: "pick_option", input: { option_number: 1, person: "Advait" } });
      const msg = out.join("\n");
      check(r, /full/i.test(msg) && /17:00/.test(msg) && /20:30/.test(msg), `${variant}: says full and lists free times`);
      check(r, !/12:00/.test(msg), `${variant}: no lunch times offered`);
      check(r, !out.some((m) => m.includes("🧪") || m.includes("✅ *Booked")), `${variant}: nothing booked`);
      check(r, !out.some((m) => m.includes(a.name) || m.includes(b.name)), `${variant}: no other place tried or mentioned`);
      check(r, rowsAfter("booking_log", logId).every((l) => l.place_id === tc.id), `${variant}: booking_log only ${tc.name}`);
      check(r, rowsAfter("call_log", callId).length === 0, `${variant}: no calls`);
      check(r, /\?/.test(msg), `${variant}: asks what next`);
      if (variant === "a") check(r, books === 0, "a: didn't try to book a full time");
    }
  },

  async "P0-4"(r) {
    reset();
    const [tc] = tcPlaces();
    planWith([tc], "18:30");
    let bookedAt = "";
    tablecheck.checkAvailability = async () => ({ status: "unavailable", alternatives: ["17:30", "18:45", "20:00"] });
    tablecheck.book = async (_p, slot) => {
      bookedAt = slot.time;
      return { status: "requested", detail: "DRY_RUN: stopped on the confirmation page (fake)" };
    };
    const out = await send("Advait", "1", { tool: "pick_option", input: { option_number: 1, person: "Advait" } });
    const msg = out.join("\n");
    check(r, bookedAt === "18:45", `booked 18:45 (got ${bookedAt || "nothing"})`);
    check(r, msg.includes("🧪") && msg.includes("18:45"), "says 18:45 would be booked");
    check(r, /18:30[–-]19:00/.test(msg) && /window/.test(msg), "says it's inside the 18:30–19:00 window");
  },

  async "P0-5"(r) {
    reset();
    const [ph] = phoneOnly();
    planWith([ph]);
    const callId = maxId("call_log");
    const out1 = await send("Advait", "1", { tool: "pick_option", input: { option_number: 1, person: "Advait" } });
    check(r, out1.some((m) => /Shall I call/.test(m) && m.includes(ph.name)), `asks "Shall I call ${ph.name}?"`);
    check(r, rowsAfter("call_log", callId).length === 0, "call_log empty before the yes");
    const out2 = await send("Advait", "call", { tool: "place_call", input: {} });
    const calls = rowsAfter("call_log", callId);
    check(r, calls.length === 1 && calls[0].place_id === ph.id, `exactly one (fake) call, to ${ph.name} (got ${calls.length})`);
    check(r, out2.some((m) => /Booked/.test(m) && m.includes(ph.name)), "reports the call outcome");
    check(r, ![...out1, ...out2].some((m) => EM_DASH.test(m)), "no em dashes");
  },

  async "P0-6"(r) {
    if (TOOLS_ONLY) return void (r.pass = null, r.notes.push("needs the agent (LLM)"));
    if (!p01PlanId) {
      reset();
      await send("Advait", "plan wednesday");
      p01PlanId = (db().prepare("SELECT id FROM plans WHERE status = 'proposed' ORDER BY id DESC LIMIT 1").get() as { id: number } | undefined)?.id;
    }
    const before = new Set(p01PlanId ? getPlan(p01PlanId)!.options.map((o) => o.placeId) : []);
    const planMax = maxId("plans");
    const out = await send("Advait", "new options, Mexican with live music");
    const msg = out.join("\n\n");
    check(r, /(couldn'?t find|nothing|no )[^.\n]*(mexican|live music)/i.test(msg) || /Nothing fits/i.test(msg), "says what wasn't found");
    const claims = msg
      .split(/\n|(?<=\.)\s/)
      .filter((l) => /mexican|live music/i.test(l) && !/couldn'?t|can'?t|didn'?t|no |not |nothing|none|isn'?t|without|closest/i.test(l));
    check(r, claims.length === 0, `never claims a match${claims.length ? `: ${claims.join(" | ")}` : ""}`);
    const plan = db().prepare("SELECT id FROM plans WHERE id > ? ORDER BY id DESC LIMIT 1").get(planMax) as { id: number } | undefined;
    const after = plan ? getPlan(plan.id)!.options.map((o) => o.placeId) : [];
    check(r, after.every((id) => !before.has(id)), `different places from before (${after.map((id) => getPlace(id)!.name).join(", ") || "no new options"})`);
    check(r, !out.some((m) => EM_DASH.test(m)), "no em dashes");
  },

  async "P0-7"(r) {
    // About who has to agree, not TableCheck: a stubbed TableCheck, so P0-2 is the only test holding a real table
    // (each dry run holds the slot for 10 minutes, and a second hold can make it look full).
    const fakeTc = () => {
      tablecheck.checkAvailability = async () => ({ status: "available" });
      tablecheck.book = async () => ({ status: "requested", detail: "DRY_RUN: stopped on the confirmation page (fake)" });
    };
    reset();
    fakeTc();
    config.wa.solo = false;
    const free = { place: tcPlaces()[0], time: "18:30" };
    const [a, b] = phoneOnly();
    planWith([free.place, a, b], free.time);
    let logId = maxId("booking_log");
    const out1 = await send("Advait", "1", { tool: "pick_option", input: { option_number: 1, person: "Advait" } });
    check(r, !out1.some((m) => m.includes("🧪")) && rowsAfter("booking_log", logId).length === 0, "Advait's pick alone books nothing");
    const out2 = await send("Emily", "1", { tool: "pick_option", input: { option_number: 1, person: "Emily" } });
    check(r, out2.some((m) => m.includes("🧪") && m.includes(free.place.name)), `Emily's matching pick books ${free.place.name}`);

    // Different picks: asks, books nothing.
    reset();
    fakeTc();
    config.wa.solo = false;
    planWith([free.place, a, b], free.time);
    logId = maxId("booking_log");
    const callId = maxId("call_log");
    await send("Advait", "1", { tool: "pick_option", input: { option_number: 1, person: "Advait" } });
    const out4 = await send("Emily", "2", { tool: "pick_option", input: { option_number: 2, person: "Emily" } });
    check(r, out4.some((m) => /split|which one|differ/i.test(m)), "different picks: asks which one");
    check(r, rowsAfter("booking_log", logId).length === 0 && rowsAfter("call_log", callId).length === 0, "different picks: nothing booked or called");
    config.wa.solo = true;
  },
};

// ---------- run ----------

await ensureFixtures();
for (const id of Object.keys(TESTS)) {
  if (only.length && !only.includes(id)) continue;
  console.log(`\n========== ${id} ==========`);
  const r: Result = { id, pass: true, notes: [] };
  try {
    await TESTS[id](r);
  } catch (err) {
    r.pass = false;
    r.notes.push(`💥 ${(err as Error).stack ?? err}`);
  }
  results.push(r);
}
await closeBrowsers();

const label = (p: boolean | null) => (p === null ? "⏭️ skipped" : p ? "✅ pass" : "❌ fail");
const report = [
  `# P0 run ${new Date().toISOString()} (${TOOLS_ONLY ? "tools only, no LLM" : "through the agent"})`,
  "",
  "| # | Result | Checks |",
  "|---|---|---|",
  ...results.map((r) => `| ${r.id} | ${label(r.pass)} | ${r.notes.join("<br>").replace(/\|/g, "/")} |`),
].join("\n");
console.log(`\n${report}`);
fs.writeFileSync(path.join(config.dataDir, `p0-report${TOOLS_ONLY ? "-tools" : ""}.md`), report);
process.exit(results.some((r) => r.pass === false) ? 1 : 0);

import { z } from "zod";
import { config, domesticPhone, intlPhone, testCallee, type Contact } from "../config";
import { extract } from "../llm";
import { status } from "../notify";
import { logCall } from "../logbook";
import type { Place, Reservation } from "../types";
import { latestOk } from "./window";
import { DateTime } from "luxon";
import { now, ZONE } from "../util/time";
import type { AvailabilityResult, BookingAdapter, BookResult, ChangeResult, Slot } from "./types";

/**
 * AI phone calls through Vapi (vapi.ai): Vapi runs the call (Japanese speech
 * recognition, a natural voice, Claude for the conversation); we give it a
 * booking script, wait for the call to end, then read the transcript with
 * Claude to get the outcome.
 *
 * Calls to Japan need a Twilio number imported into Vapi (VAPI_PHONE_NUMBER_ID);
 * Vapi's free numbers only call the US. In DRY_RUN every call goes to
 * BOOKING_PHONE (you) instead of the restaurant, so you can play the restaurant.
 */

const API = "https://api.vapi.ai";

export function vapiConfigured(): boolean {
  return Boolean(fakeCallSpec() || (process.env.VAPI_API_KEY && process.env.VAPI_PHONE_NUMBER_ID));
}

/**
 * Tests only: CALL_FAKE=<outcome>[:<times>] answers every call without dialing,
 * e.g. "booked", "booked:19:00", "full:19:30,20:00", "busy". Dry run only.
 */
function fakeCallSpec(): { outcome: CallOutcomeKind; times: string[] } | null {
  const raw = process.env.CALL_FAKE?.trim();
  if (!raw || !config.dryRun) return null;
  const [outcome, rest = ""] = raw.split(/:(.*)/s);
  return { outcome: outcome as CallOutcomeKind, times: rest.split(",").map((t) => t.trim()).filter(Boolean) };
}

/** "03-6431-8960" / "070-1568-0178" → "+81364318960" (E.164, as Vapi requires). */
export function toE164(phone: string): string {
  const intl = intlPhone(domesticPhone(phone)).replace(/[\s-()]/g, "");
  return intl.startsWith("+") ? intl : `+${intl}`;
}

async function vapi<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`Vapi ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

export type CallLanguage = "ja" | "en";

export interface CallScript {
  firstMessage: string;
  systemPrompt: string;
  language: CallLanguage;
}

/**
 * The name phone bookings go under: short and easy for staff to write in
 * katakana (Emily / エミリー by default). Booking sites keep BOOKING_NAME.
 */
export function callName(): { name: string; kana: string } {
  return { name: config.call.bookingName, kana: config.call.bookingNameKana };
}

/**
 * The booking conversation: seats only, honest that it's an AI, and an
 * "authority envelope" instead of a script for every case. It knows today's
 * date and the booking date, may accept any time inside the couple's window
 * on that date, and for anything else (other times or dates, conditions)
 * notes it and says it'll call back. Cancellation policy is looked up online
 * before the call (calls.ts), so it isn't asked.
 */
/**
 * Dates, times and numbers written the way they should be spoken. Text-to-speech
 * mangles digits ("21st" heard as "Tony", "18:30" as "18 30", a phone number as a
 * jumble), so the caller gets them as words and is told to say them exactly so.
 */
const ORD = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;
export function spokenDateEn(date: string): string {
  const d = DateTime.fromISO(date, { zone: ZONE }).setLocale("en");
  return `${d.toFormat("cccc")}, ${d.toFormat("LLLL")} ${ORD(d.day)}`;
}
export function spokenTimeEn(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "a.m." : "p.m."}`;
}
const DIGITS_EN = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const DIGITS_JA = ["ゼロ", "イチ", "ニー", "サン", "ヨン", "ゴー", "ロク", "ナナ", "ハチ", "キュー"];
/** "090-1234-5678" → "zero nine zero, one two three four, …" (or ゼロキューゼロ、…). */
export function spokenPhone(phone: string, lang: CallLanguage): string {
  const groups = domesticPhone(phone).split(/[^0-9]+/).filter(Boolean);
  return lang === "en" ? groups.map((g) => [...g].map((d) => DIGITS_EN[+d]).join(" ")).join(", ") : groups.map((g) => [...g].map((d) => DIGITS_JA[+d]).join("")).join("、");
}
export function spokenDateJa(date: string): string {
  const d = DateTime.fromISO(date, { zone: ZONE });
  return `${d.month}月${d.day}日、${"月火水木金土日"[d.weekday - 1]}曜日`;
}
export function spokenTimeJa(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const h12 = h > 12 ? h - 12 : h;
  return `${h >= 12 ? "午後" : "午前"}${h12}時${m === 30 ? "半" : m ? `${m}分` : ""}`;
}

export function bookingScript(place: Place, slot: Slot, c: Contact, language: CallLanguage, task: "book" | "cancel" = "book", existing?: Reservation): CallScript {
  const { name, kana } = callName();
  const today = now();
  const latest = latestOk(slot);
  const flexible = latest !== slot.time;
  if (language === "en") {
    const day = spokenDateEn;
    const at = spokenTimeEn;
    return {
      language,
      firstMessage: `Hello, is this ${place.name}? I'm an AI assistant calling for ${name} ${task === "book" ? "to make a reservation" : "about a reservation"}.`,
      systemPrompt: `You are a polite AI assistant on a phone call with the restaurant ${place.name}, calling for ${name}. Keep it short and friendly.
Today is ${today.setLocale("en").toFormat("cccc d LLLL yyyy")}.
Goal: ${
        task === "book"
          ? `a seat reservation for ${DIGITS_EN[slot.partySize] ?? slot.partySize} people on ${day(slot.date)} at ${at(slot.time)}.`
          : `cancel the reservation for ${DIGITS_EN[existing?.party_size ?? 2] ?? existing?.party_size} people on ${existing ? day(existing.date) : ""} at ${existing ? at(existing.time) : ""} under the name ${name}.`
      }
What you may agree to:
- ${flexible ? `Any time from ${at(slot.time)} to ${at(latest)} on ${day(slot.date)}. If ${at(slot.time)} is full, ask whether anything until ${at(latest)} is free and book it.` : `Only ${at(slot.time)} on ${day(slot.date)}.`}
- Seats only. Don't mention courses unless they bring them up; then say just seats, please. Never agree to a set course, prepayment or a credit card.
Anything else (another date, a time outside that, a condition): thank them, note it, and say you'll check with ${name} and call back. Don't book it.
If they seem to mean a different date (or a date that has passed), politely restate: "It's for ${day(slot.date)}."
If they accept, confirm the date, time, number of people, the name ${name} and the phone number: ${spokenPhone(c.phone, "en")}.
Say dates, times and numbers exactly as written in these instructions (e.g. "${day(slot.date)}", "${at(slot.time)}"): never a different day, never 24-hour times, never digits.
Say you are an AI assistant if asked. When done, thank them and end with "Goodbye." (only then).`,
    };
  }
  const jaDay = (d: string) => {
    const x = DateTime.fromISO(d, { zone: ZONE });
    return `${x.month}月${x.day}日（${"月火水木金土日"[x.weekday - 1]}）`;
  };
  const who = kana || name;
  return {
    language,
    // No 失礼いたします in the greeting: it's an end-call phrase, and Vapi hung up right after the greeting.
    firstMessage: `お忙しいところ恐れ入ります。${place.name_local ?? place.name}様でしょうか。${who}様の${task === "book" ? "ご予約" : "予約の件"}でお電話しております、AIアシスタントです。`,
    systemPrompt: `あなたは${who}様の代理でレストラン「${place.name_local ?? place.name}」に電話している、丁寧なAIアシスタントです。日本語の敬語で、短く自然に話してください。
今日は${today.year}年${jaDay(today.toISODate()!)}です。
目的：${
      task === "book"
        ? `${spokenDateJa(slot.date)}、${spokenTimeJa(slot.time)}から${slot.partySize}名、席のみの予約。`
        : `${existing ? spokenDateJa(existing.date) : ""}、${existing ? spokenTimeJa(existing.time) : ""}、${existing?.party_size}名、${who}名義の予約のキャンセル。`
    }
同意してよいこと：
- ${flexible ? `${spokenDateJa(slot.date)}の${spokenTimeJa(slot.time)}から${spokenTimeJa(latest)}の間ならどの時間でも可。${spokenTimeJa(slot.time)}が満席なら${spokenTimeJa(latest)}までに空きがないか伺い、あれば予約する。` : `${spokenDateJa(slot.date)}の${spokenTimeJa(slot.time)}のみ。`}
- 席のみ。コースの話は相手から出た場合だけ「席のみでお願いします」と伝える。コース、事前決済、クレジットカードには同意しない。
それ以外（別の日、範囲外の時間、条件付き）は、お礼を言ってメモし、「本人に確認して折り返しご連絡します」と伝える。予約はしない。
相手が別の日付（過去の日付など）を言った場合は、「${spokenDateJa(slot.date)}でございます」と丁寧に言い直す。
予約できたら、日時・人数・お名前（${who}）・電話番号（${spokenPhone(c.phone, "ja")}）を確認する。
日付・時間・番号は、この指示に書いてある通りの言い方で話す（例：「${spokenDateJa(slot.date)}」「${spokenTimeJa(slot.time)}」）。別の日付や24時間表記、数字の羅列は使わない。
AIかと聞かれたら正直に答える。用件が済んだら、最後に必ず「本日はありがとうございました。失礼いたします。」と言って電話を終える（途中では「失礼いたします」と言わない）。`,
  };
}

interface VapiCall {
  id: string;
  status: string;
  endedReason?: string;
  startedAt?: string;
  endedAt?: string;
  cost?: number;
  artifact?: { transcript?: string; recordingUrl?: string };
}

/** Start an outbound call. Uses Claude for the conversation and Japanese/English speech. */
export async function startCall(to: string, script: CallScript): Promise<VapiCall> {
  return vapi<VapiCall>("/call", {
    method: "POST",
    body: JSON.stringify({
      phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
      customer: { number: toE164(to) },
      assistant: {
        name: "Date night planner",
        firstMessage: script.firstMessage,
        firstMessageMode: "assistant-speaks-first",
        maxDurationSeconds: 300,
        backgroundSound: "off",
        model: {
          provider: "anthropic",
          model: process.env.VAPI_MODEL || "claude-sonnet-5",
          messages: [{ role: "system", content: script.systemPrompt }],
        },
        transcriber: { provider: "deepgram", model: "nova-2", language: script.language },
        // Flash: ElevenLabs' low-latency model (speaks Japanese too); VAPI_VOICE_MODEL=eleven_multilingual_v2 for the slower, richer one.
        voice: { provider: "11labs", voiceId: process.env.VAPI_VOICE_ID || "sarah", model: process.env.VAPI_VOICE_MODEL || "eleven_flash_v2_5" },
        // Only the closing line ends the call (a greeting like お忙しいところ失礼いたします used to).
        endCallPhrases: script.language === "ja" ? ["本日はありがとうございました"] : ["goodbye"],
      },
    }),
  });
}

/** Poll until the call ends (or the timeout passes). */
export async function waitForCall(id: string, timeoutMs = 8 * 60_000, onStatus?: (s: string) => void): Promise<VapiCall> {
  const start = Date.now();
  let last = "";
  for (;;) {
    const call = await vapi<VapiCall>(`/call/${id}`);
    if (call.status !== last) onStatus?.((last = call.status));
    if (call.status === "ended") return call;
    if (Date.now() - start > timeoutMs) throw new Error(`call ${id} still ${call.status} after ${timeoutMs / 1000}s`);
    await new Promise((r) => setTimeout(r, 4000));
  }
}

export const CallOutcomeSchema = z.object({
  outcome: z
    .enum(["booked", "full", "declined", "no_answer", "busy", "voicemail", "closed", "wrong_number", "callback", "cancelled", "unclear"])
    .describe(
      "booked: table confirmed. full: no table at that time. declined: they'd only take it with a course, card or other condition we refuse. closed: they said or a recording said they're closed (holiday, not open yet). wrong_number: not this restaurant. callback: they'll call the customer back. cancelled: an existing booking was cancelled. unclear: hung up or nothing was settled.",
    ),
  bookedTime: z.string().nullable().describe("HH:mm if a booking was made"),
  alternativeTimes: z.array(z.string()).describe("HH:mm times the restaurant offered"),
  cancellationPolicy: z.string().nullable().describe("What they said about cancelling, quoted or closely paraphrased"),
  requirements: z.string().nullable().describe("Any conditions they mentioned: course required, card, time limit, deposit"),
  summaryEn: z.string().describe("One or two plain sentences for the couple"),
});
export type CallOutcome = z.infer<typeof CallOutcomeSchema>;
export type CallOutcomeKind = CallOutcome["outcome"] | "failed";

/** What a call came to, plus a friendly reason when it never connected. */
export interface CallReport {
  outcome: Omit<CallOutcome, "outcome"> & { outcome: CallOutcomeKind };
  transcript: string;
  endedReason?: string;
  /** Why the call couldn't be placed, in plain words with the fix. */
  failure?: string;
}

const blank = (outcome: CallOutcomeKind, summaryEn: string): CallReport["outcome"] => ({
  outcome,
  bookedTime: null,
  alternativeTimes: [],
  cancellationPolicy: null,
  requirements: null,
  summaryEn,
});

/** Vapi's ended reasons that settle the outcome without reading a transcript. */
export function outcomeFromEndedReason(endedReason: string | undefined, transcript: string): CallOutcomeKind | null {
  const r = endedReason ?? "";
  if (r === "customer-busy") return "busy";
  if (r === "customer-did-not-answer") return "no_answer";
  if (r === "voicemail") return "voicemail";
  if (!transcript.trim()) return /error|fail|fault/i.test(r) ? "failed" : "no_answer";
  return null;
}

export async function readOutcome(transcript: string, endedReason: string | undefined, goal: string): Promise<CallReport["outcome"]> {
  const preset = outcomeFromEndedReason(endedReason, transcript);
  if (preset) return blank(preset, preset === "failed" ? `The call didn't connect (${endedReason}).` : `Ended: ${endedReason ?? "no answer"}.`);
  return extract(
    CallOutcomeSchema,
    "You read the transcript of an AI assistant's phone call to a Japanese restaurant and report what happened. Only use what was said.",
    `Goal of the call: ${goal}\nCall ended: ${endedReason ?? "unknown"}\n\nTranscript:\n${transcript}`,
  );
}

// ---------- why a call couldn't be placed ----------

/** Twilio account balance in USD, when TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are set. */
export async function twilioBalance(): Promise<number | null> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Balance.json`, {
      headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}` },
    });
    if (!res.ok) return null;
    return Number(((await res.json()) as { balance: string }).balance);
  } catch {
    return null;
  }
}

/** Twilio's most recent error alert (last 30 min), e.g. "Account not active" or a geo-permission block. */
async function twilioLatestAlert(): Promise<string | null> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  try {
    const since = new Date(Date.now() - 30 * 60_000).toISOString();
    const res = await fetch(`https://monitor.twilio.com/v1/Alerts?PageSize=1&StartDate=${encodeURIComponent(since)}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}` },
    });
    if (!res.ok) return null;
    const a = ((await res.json()) as { alerts?: { error_code?: string; alert_text?: string }[] }).alerts?.[0];
    if (!a) return null;
    const msg = new URLSearchParams(a.alert_text ?? "").get("Msg") ?? a.alert_text ?? "";
    return `error ${a.error_code}${msg ? `: ${msg}` : ""}`;
  } catch {
    return null;
  }
}

/** Calls under this balance would likely be cut off, so don't start them. */
export const MIN_TWILIO_BALANCE = 0.5;

/** Japan rates from twilio.com/voice/pricing/jp (Oct 2026); check there before relying on them. */
const TWILIO_JP_RATES = "about $0.19/min to mobiles and $0.07/min to landlines";

/** Turn a failed call start into a plain sentence with the fix. */
export async function explainCallFailure(raw: string): Promise<string> {
  if (/balance|credit|wallet|payment|billing|insufficient/i.test(raw) && /vapi/i.test(raw)) {
    return `Vapi is out of credit. Top up at dashboard.vapi.ai → Billing.`;
  }
  const balance = await twilioBalance();
  if (balance != null && balance < MIN_TWILIO_BALANCE) {
    return `Twilio balance is $${balance.toFixed(2)}. Calls to Japan cost ${TWILIO_JP_RATES}, so top up at console.twilio.com → Billing.`;
  }
  const alert = await twilioLatestAlert();
  if (alert) return `Twilio reported ${alert}. Details: console.twilio.com → Monitor → Logs → Errors.`;
  if (/get-transport|twilio/i.test(raw)) {
    const hint = process.env.TWILIO_ACCOUNT_SID ? "" : " (Add TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN to .env and I can check the balance myself.)";
    return `Twilio didn't connect the call. That's usually an empty balance or Japan turned off in Voice → Geo permissions.${hint}`;
  }
  return `The call service said: ${raw.slice(0, 200)}`;
}

/** Who to dial: the restaurant, or in DRY_RUN the stand-in (CALL_TEST_TO, default you). */
function dialTarget(place: Place): string | null {
  if (config.dryRun) return testCallee().phone || null;
  return place.phone ?? null;
}

const CALL_STATUS: Record<string, string> = { ringing: "ringing", "in-progress": "on the call" };

async function runCall(place: Place, c: Contact, script: CallScript, goal: string, kind = "book"): Promise<CallReport> {
  const to = config.dryRun ? testCallee().phone || null : (place.phone ?? null);
  const report = await placeCall(place, to, script, goal);
  // Every call (or failed attempt to call) goes into the call log, transcript and all.
  logCall({
    placeId: place.id ?? null,
    placeName: place.name,
    kind,
    toNumber: to,
    vapiId: report.call?.id,
    endedReason: report.endedReason ?? null,
    durationSec: report.call?.startedAt && report.call?.endedAt ? (Date.parse(report.call.endedAt) - Date.parse(report.call.startedAt)) / 1000 : null,
    costUsd: report.call?.cost ?? null,
    outcome: report.outcome.outcome,
    summary: report.failure ?? report.outcome.summaryEn,
    transcript: report.transcript || null,
    recordingUrl: report.call?.artifact?.recordingUrl ?? null,
    dryRun: config.dryRun,
  });
  return report;
}

async function placeCall(place: Place, to: string | null, script: CallScript, goal: string): Promise<CallReport & { call?: VapiCall }> {
  const fake = fakeCallSpec();
  if (fake) {
    const outcome = { ...blank(fake.outcome, `Fake call (CALL_FAKE): ${fake.outcome}.`), bookedTime: fake.outcome === "booked" ? (fake.times[0] ?? null) : null, alternativeTimes: fake.outcome === "booked" ? [] : fake.times };
    return { outcome, transcript: `[fake call: ${goal}]`, endedReason: "fake" };
  }
  if (!vapiConfigured()) return { outcome: blank("failed", "calls aren't set up"), transcript: "", failure: "Phone calls aren't set up yet (VAPI_API_KEY and VAPI_PHONE_NUMBER_ID in .env)." };
  if (!to) return { outcome: blank("failed", "no phone number"), transcript: "", failure: config.dryRun ? `No number for the test call (CALL_TEST_TO=${config.call.testTo || "BOOKING_PHONE"}). Check .env.` : `I don't have a phone number for ${place.name}.` };
  const balance = await twilioBalance();
  if (balance != null && balance < MIN_TWILIO_BALANCE) {
    return { outcome: blank("failed", "low balance"), transcript: "", failure: `Twilio balance is $${balance.toFixed(2)}, too low for a call. Calls to Japan cost ${TWILIO_JP_RATES}; top up at console.twilio.com → Billing.` };
  }
  let done: VapiCall;
  try {
    const call = await startCall(to, script);
    done = await waitForCall(call.id, 8 * 60_000, (s) => {
      if (CALL_STATUS[s]) void status(`📞 ${place.name}: ${CALL_STATUS[s]}…`);
    });
  } catch (err) {
    const raw = (err as Error).message;
    return { outcome: blank("failed", raw), transcript: "", failure: await explainCallFailure(raw) };
  }
  const transcript = done.artifact?.transcript ?? "";
  const outcome = await readOutcome(transcript, done.endedReason, goal);
  const failure = outcome.outcome === "failed" ? await explainCallFailure(done.endedReason ?? "") : undefined;
  return { outcome, transcript, endedReason: done.endedReason, failure, call: done };
}

/** Booking call. Only ever started after someone in the chat said yes (see calls.ts). */
export function callToBook(place: Place, slot: Slot, c: Contact): Promise<CallReport> {
  return runCall(place, c, bookingScript(place, slot, c, config.call.language), `book ${slot.partySize} people on ${slot.date} at ${slot.time}, seats only`);
}

/** The script for moving an existing booking (exported for tests). */
export function modifyScript(r: Reservation, place: Place, slot: Slot, c: Contact): CallScript {
  const lang = config.call.language;
  const script = bookingScript(place, slot, c, lang);
  // Spoken forms here too: this call said "change that to 20 dollars" for 20:00 (round 2).
  if (lang === "en") {
    script.firstMessage = script.firstMessage.replace("to make a reservation", "about a reservation");
    script.systemPrompt += `\nThis is about an existing booking: ${spokenDateEn(r.date)} at ${spokenTimeEn(r.time)}, ${DIGITS_EN[r.party_size] ?? r.party_size} people, under ${callName().name}. Ask whether it can be changed to ${spokenDateEn(slot.date)} at ${spokenTimeEn(slot.time)} for ${DIGITS_EN[slot.partySize] ?? slot.partySize} people. Say these exactly as written.`;
  } else {
    script.firstMessage = script.firstMessage.replace("ご予約でお電話", "予約の件でお電話");
    script.systemPrompt += `\n既存の予約（${spokenDateJa(r.date)}、${spokenTimeJa(r.time)}、${r.party_size}名）を、${spokenDateJa(slot.date)}、${spokenTimeJa(slot.time)}、${slot.partySize}名に変更できるか伺ってください。日時はこの通りの言い方で話してください。`;
  }
  return script;
}

export function callToModify(r: Reservation, place: Place, slot: Slot, c: Contact): Promise<CallReport> {
  return runCall(place, c, modifyScript(r, place, slot, c), `change booking to ${slot.date} ${slot.time} for ${slot.partySize}`, "modify");
}

export function callToCancel(r: Reservation, place: Place, c: Contact): Promise<CallReport> {
  const slot = { date: r.date, time: r.time, partySize: r.party_size };
  return runCall(place, c, bookingScript(place, slot, c, config.call.language, "cancel", r), `cancel the booking on ${r.date} ${r.time}`, "cancel");
}

/**
 * The BookingAdapter face of phone calls. The booking service never calls these
 * directly: every call needs a go-ahead in the chat first (calls.ts).
 */
export const phone: BookingAdapter = {
  channel: "phone",

  async checkAvailability(): Promise<AvailabilityResult> {
    return { status: "unknown", detail: "phone bookings are confirmed on the call" };
  },

  async book(place: Place, slot: Slot, c: Contact): Promise<BookResult> {
    const { outcome, failure } = await callToBook(place, slot, c);
    if (outcome.outcome === "booked") return { status: "confirmed", policyText: outcome.cancellationPolicy ?? undefined, detail: outcome.summaryEn };
    return { status: "failed", full: outcome.outcome === "full", alternatives: outcome.alternativeTimes, detail: failure ?? outcome.summaryEn };
  },

  async modify(r: Reservation, place: Place, slot: Slot, c: Contact): Promise<ChangeResult> {
    const { outcome, failure } = await callToModify(r, place, slot, c);
    return { ok: outcome.outcome === "booked", detail: failure ?? outcome.summaryEn };
  },

  async cancel(r: Reservation, place: Place, c: Contact): Promise<ChangeResult> {
    const { outcome, failure } = await callToCancel(r, place, c);
    return { ok: outcome.outcome === "cancelled", detail: failure ?? outcome.summaryEn };
  },
};

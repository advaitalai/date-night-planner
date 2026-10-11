import { z } from "zod";
import { config, domesticPhone, intlPhone, type Contact } from "../config";
import { extract } from "../llm";
import { status } from "../notify";
import type { Place, Reservation } from "../types";
import { jaDate } from "./email";
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
  return Boolean(process.env.VAPI_API_KEY && process.env.VAPI_PHONE_NUMBER_ID);
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

/** The booking conversation. Seat-only, no courses, no card, honest that it's an AI. */
export function bookingScript(place: Place, slot: Slot, c: Contact, language: CallLanguage, task: "book" | "cancel" = "book", existing?: Reservation): CallScript {
  const when = jaDate(slot.date, slot.time);
  const spoken = config.call.nameSpoken || c.name;
  if (language === "en") {
    return {
      language,
      firstMessage: `Hello, is this ${place.name}? I'm an AI assistant calling on behalf of ${spoken} ${task === "book" ? "to make a reservation" : "about a reservation"}.`,
      systemPrompt: `You are a polite AI assistant on a phone call with the restaurant ${place.name}, calling on behalf of ${spoken}.
Goal: ${task === "book" ? `book a table for ${slot.partySize} on ${slot.date} at ${slot.time}, seats only (no set course).` : `cancel the reservation for ${existing?.party_size} on ${existing?.date} at ${existing?.time} under the name ${c.name}.`}
Rules:
- Say you are an AI assistant if asked, and keep it short and friendly.
- Never agree to a set course, prepayment or giving a credit card. If they require one, thank them and end the call.
- If the time is full and they offer another time, don't turn it down or ask for more options: thank them, note it, and say you'll check with ${spoken} and call back shortly to confirm. If they don't offer one, ask for the nearest free times within an hour either side. Never book a different time yourself.
- If they accept, confirm the date, time, number of people, the name ${spoken} and the phone number ${intlPhone(c.phone)}.
- Ask about the cancellation policy (until when you can cancel for free).
- When done, thank them and say goodbye.`,
    };
  }
  return {
    language,
    firstMessage: `お忙しいところ失礼いたします。${place.name}様でしょうか。${c.nameKana || c.name}様の代理で${task === "book" ? "予約" : "予約の件"}のお電話をしております、AIアシスタントです。`,
    systemPrompt: `あなたは${c.nameKana || c.name}（${c.name}）様の代理でレストラン「${place.name}」に電話している、丁寧なAIアシスタントです。日本語の敬語で、短く自然に話してください。
目的：${task === "book" ? `${when}から${slot.partySize}名で、席のみ（コースなし）の予約を取ること。` : `${existing ? jaDate(existing.date, existing.time) : ""}${existing?.party_size}名、${c.nameKana || c.name}名義の予約をキャンセルすること。`}
ルール：
- AIであることを聞かれたら正直に答える。
- コース料理、事前決済、クレジットカード情報の提供には同意しない。必須と言われたらお礼を言って電話を終える。
- 満席で別の時間を提案された場合は、断ったり他の時間を重ねて聞いたりせず、お礼を言ってメモし、「本人に確認して、すぐに折り返しご連絡します」と伝える。提案がなければ、前後1時間以内の空いている時間を伺う。別の時間で勝手に予約しない。
- 予約できた場合は、日時・人数・お名前（${c.nameKana || c.name}）・電話番号（${domesticPhone(c.phone)}）を確認する。
- キャンセルポリシー（いつまで無料でキャンセルできるか）を確認する。
- 最後にお礼を言って電話を終える。`,
  };
}

interface VapiCall {
  id: string;
  status: string;
  endedReason?: string;
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
        voice: { provider: "11labs", voiceId: process.env.VAPI_VOICE_ID || "sarah", model: "eleven_multilingual_v2" },
        endCallPhrases: script.language === "ja" ? ["失礼いたします", "失礼します"] : ["goodbye", "bye"],
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

/** Who to dial: the restaurant, or in DRY_RUN the booking contact (you). */
function dialTarget(place: Place, c: Contact): string | null {
  if (config.dryRun) return c.phone || null;
  return place.phone ?? null;
}

const CALL_STATUS: Record<string, string> = { ringing: "ringing", "in-progress": "on the call" };

async function runCall(place: Place, c: Contact, script: CallScript, goal: string): Promise<CallReport> {
  if (!vapiConfigured()) return { outcome: blank("failed", "calls aren't set up"), transcript: "", failure: "Phone calls aren't set up yet (VAPI_API_KEY and VAPI_PHONE_NUMBER_ID in .env)." };
  const to = dialTarget(place, c);
  if (!to) return { outcome: blank("failed", "no phone number"), transcript: "", failure: `I don't have a phone number for ${place.name}.` };
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
  return { outcome, transcript, endedReason: done.endedReason, failure };
}

/** Booking call. Only ever started after someone in the chat said yes (see calls.ts). */
export function callToBook(place: Place, slot: Slot, c: Contact): Promise<CallReport> {
  return runCall(place, c, bookingScript(place, slot, c, config.call.language), `book ${slot.partySize} people on ${slot.date} at ${slot.time}, seats only`);
}

export function callToModify(r: Reservation, place: Place, slot: Slot, c: Contact): Promise<CallReport> {
  const script = bookingScript(place, slot, c, config.call.language);
  script.systemPrompt +=
    config.call.language === "en"
      ? `\nThis is about an existing booking (${r.date} ${r.time}, ${r.party_size} people). Ask whether it can be changed to ${slot.date} ${slot.time} for ${slot.partySize}.`
      : `\n既存の予約（${jaDate(r.date, r.time)}、${r.party_size}名）を、${jaDate(slot.date, slot.time)}、${slot.partySize}名に変更できるか伺ってください。`;
  return runCall(place, c, script, `change booking to ${slot.date} ${slot.time} for ${slot.partySize}`);
}

export function callToCancel(r: Reservation, place: Place, c: Contact): Promise<CallReport> {
  const slot = { date: r.date, time: r.time, partySize: r.party_size };
  return runCall(place, c, bookingScript(place, slot, c, config.call.language, "cancel", r), `cancel the booking on ${r.date} ${r.time}`);
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

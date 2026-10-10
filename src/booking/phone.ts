import { z } from "zod";
import { config, domesticPhone, intlPhone, type Contact } from "../config";
import { extract } from "../llm";
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
  if (language === "en") {
    return {
      language,
      firstMessage: `Hello, is this ${place.name}? I'm an AI assistant calling on behalf of ${c.name} ${task === "book" ? "to make a reservation" : "about a reservation"}.`,
      systemPrompt: `You are a polite AI assistant on a phone call with the restaurant ${place.name}, calling on behalf of ${c.name}.
Goal: ${task === "book" ? `book a table for ${slot.partySize} on ${slot.date} at ${slot.time}, seats only (no set course).` : `cancel the reservation for ${existing?.party_size} on ${existing?.date} at ${existing?.time} under the name ${c.name}.`}
Rules:
- Say you are an AI assistant if asked, and keep it short and friendly.
- Never agree to a set course, prepayment or giving a credit card. If they require one, thank them and end the call.
- If the time is full, ask for the nearest free times within an hour either side, note them, and say ${c.name} will call back. Do not book a different time.
- If they accept, confirm the date, time, number of people, the name ${c.name} and the phone number ${intlPhone(c.phone)}.
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
- 満席の場合は、前後1時間以内の空いている時間を伺い、メモして「改めてご連絡します」と伝える。別の時間で勝手に予約しない。
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
  outcome: z.enum(["booked", "full", "declined", "no_answer", "cancelled", "unclear"]),
  bookedTime: z.string().nullable().describe("HH:mm if a booking was made"),
  alternativeTimes: z.array(z.string()).describe("HH:mm times the restaurant offered"),
  cancellationPolicy: z.string().nullable().describe("What they said about cancelling, quoted or closely paraphrased"),
  requirements: z.string().nullable().describe("Any conditions they mentioned: course required, card, time limit, deposit"),
  summaryEn: z.string().describe("One or two plain sentences for the couple"),
});
export type CallOutcome = z.infer<typeof CallOutcomeSchema>;

export async function readOutcome(transcript: string, endedReason: string | undefined, goal: string): Promise<CallOutcome> {
  if (!transcript.trim()) {
    return { outcome: "no_answer", bookedTime: null, alternativeTimes: [], cancellationPolicy: null, requirements: null, summaryEn: `Nobody picked up (${endedReason ?? "no transcript"}).` };
  }
  return extract(
    CallOutcomeSchema,
    "You read the transcript of an AI assistant's phone call to a Japanese restaurant and report what happened. Only use what was said.",
    `Goal of the call: ${goal}\nCall ended: ${endedReason ?? "unknown"}\n\nTranscript:\n${transcript}`,
  );
}

/** Who to dial: the restaurant, or in DRY_RUN the booking contact (you). */
function dialTarget(place: Place, c: Contact): string | null {
  if (config.dryRun) return c.phone || null;
  return place.phone ?? null;
}

async function runCall(place: Place, c: Contact, script: CallScript, goal: string): Promise<{ outcome: CallOutcome; transcript: string }> {
  const to = dialTarget(place, c);
  if (!to) throw new Error("no phone number to call");
  const call = await startCall(to, script);
  const done = await waitForCall(call.id);
  const transcript = done.artifact?.transcript ?? "";
  return { outcome: await readOutcome(transcript, done.endedReason, goal), transcript };
}

export const phone: BookingAdapter = {
  channel: "phone",

  async checkAvailability(): Promise<AvailabilityResult> {
    return { status: "unknown", detail: "phone bookings are confirmed on the call" };
  },

  async book(place: Place, slot: Slot, c: Contact): Promise<BookResult> {
    if (!vapiConfigured()) return { status: "failed", detail: "phone calls aren't set up (VAPI_API_KEY / VAPI_PHONE_NUMBER_ID)" };
    if (!place.phone) return { status: "failed", detail: "no phone number" };
    const { outcome, transcript } = await runCall(place, c, bookingScript(place, slot, c, "ja"), `book ${slot.partySize} people on ${slot.date} at ${slot.time}, seats only`);
    const dry = config.dryRun ? " (dry run: called you instead of the restaurant)" : "";
    if (outcome.outcome === "booked") {
      return { status: "confirmed", policyText: outcome.cancellationPolicy ?? undefined, detail: `Booked by phone${dry}. ${outcome.summaryEn}\n\nTranscript:\n${transcript.slice(0, 1500)}` };
    }
    const alt = outcome.alternativeTimes.length ? ` They offered ${outcome.alternativeTimes.join(", ")}.` : "";
    return { status: "failed", detail: `Phone call: ${outcome.summaryEn}${alt}${dry}` };
  },

  async modify(r: Reservation, place: Place, slot: Slot, c: Contact): Promise<ChangeResult> {
    // Cancel-and-rebook over the phone is fragile; ask them to change it in one call instead.
    if (!vapiConfigured() || !place.phone) return { ok: false, detail: "phone calls aren't set up" };
    const script = bookingScript(place, slot, c, "ja");
    script.systemPrompt += `\n既存の予約（${jaDate(r.date, r.time)}、${r.party_size}名）を、${jaDate(slot.date, slot.time)}、${slot.partySize}名に変更できるか伺ってください。`;
    const { outcome } = await runCall(place, c, script, `change booking to ${slot.date} ${slot.time} for ${slot.partySize}`);
    return { ok: outcome.outcome === "booked", detail: outcome.summaryEn };
  },

  async cancel(r: Reservation, place: Place, c: Contact): Promise<ChangeResult> {
    if (!vapiConfigured() || !place.phone) return { ok: false, detail: "phone calls aren't set up" };
    const slot = { date: r.date, time: r.time, partySize: r.party_size };
    const { outcome } = await runCall(place, c, bookingScript(place, slot, c, "ja", "cancel", r), `cancel the booking on ${r.date} ${r.time}`);
    return { ok: outcome.outcome === "cancelled", detail: outcome.summaryEn };
  },
};

import { DateTime } from "luxon";
import { config, domesticPhone, testCallee } from "../config";
import { kvGet, kvSet } from "../db";
import { getPlace, getReservation, updatePlace, updatePlan, updateReservation } from "../db/repo";
import { cancelJobs } from "../jobs/scheduler";
import { status } from "../notify";
import type { Place } from "../types";
import { fmtDate, isOpenFor, now, ZONE } from "../util/time";
import { callToBook, callToCancel, callToModify, type CallReport } from "./phone";
import { applyPolicy, policyLine, recordBooking } from "./service";
import type { Slot } from "./types";
import { findPolicyOnline } from "./policy";

/**
 * Phone calls happen only with a go-ahead from the chat: deciding on a
 * phone-only place counts as one, otherwise the bot asks first and stores
 * the call here as the pending call; a yes (in any words, judged by the
 * agent) places it via place_call. Calls are made now or not at all: when
 * the restaurant is closed the bot says when it opens and waits to be told.
 */

export interface PendingCall {
  kind: "book" | "cancel" | "modify";
  placeId: number;
  slot: Slot;
  planId?: number;
  reservationId?: number;
  reason?: string;
  /** Times the restaurant offered on the last call (for "try 19:00"). */
  alternatives?: string[];
}

const KEY = "pending_call";
const EXPIRES_H = 12;

export function pendingCall(): PendingCall | null {
  const p = kvGet<(PendingCall & { askedAt: string }) | null>(KEY, null);
  if (!p) return null;
  if (Date.now() - Date.parse(p.askedAt) > EXPIRES_H * 3600_000) {
    kvSet(KEY, null);
    return null;
  }
  return p;
}

function setPending(call: PendingCall): void {
  kvSet(KEY, { ...call, askedAt: new Date().toISOString() });
}

export function clearPendingCall(): void {
  kvSet(KEY, null);
}

/** Short summary of the pending call, for the agent's state block. */
export function describePendingCall(): string | null {
  const p = pendingCall();
  if (!p) return null;
  const place = getPlace(p.placeId);
  return `Waiting for a go-ahead to call ${place?.name ?? "?"} to ${task(p)}${p.alternatives?.length ? ` (they offered ${p.alternatives.join(", ")})` : ""}.`;
}

function task(call: PendingCall): string {
  const when = `${fmtDate(call.slot.date)} ${call.slot.time} for ${call.slot.partySize}`;
  if (call.kind === "cancel") return `cancel the booking on ${when}`;
  if (call.kind === "modify") return `change the booking to ${when}`;
  return `book ${when}, seats only`;
}

/** The next time the place is open (phones are answered then), within two days. */
export function nextOpening(place: Place, from = now()): DateTime | null {
  if (!place.opening_periods?.length) return null;
  let t = from.setZone(ZONE).startOf("minute");
  t = t.set({ minute: Math.ceil(t.minute / 15) * 15 });
  for (let i = 0; i < 4 * 48; i++, t = t.plus({ minutes: 15 })) {
    if (isOpenFor(place.opening_periods, t, 15)) return t;
  }
  return null;
}

/** Known to be closed right now (unknown hours count as open). */
export function closedNow(place: Place): boolean {
  return isOpenFor(place.opening_periods, now(), 15) === false;
}

function opensAt(place: Place): string {
  const next = nextOpening(place);
  if (!next) return "They're closed right now.";
  return `They're closed right now and open ${next.hasSame(now(), "day") ? "at" : next.toFormat("ccc")} ${next.toFormat("HH:mm")}.`;
}

/** Store the call and ask for a go-ahead. Returns the message to post. */
export function askToCall(call: PendingCall, place: Place, tried: string[]): string {
  setPending(call);
  const lines: string[] = [];
  if (call.kind === "book") {
    lines.push(tried.length ? `📞 *${place.name}*: booking online didn't work.\n${tried.map((t) => `• ${t}`).join("\n")}` : `📞 *${place.name}* takes bookings by phone.`);
  } else {
    lines.push(`📞 *${place.name}* was booked by phone, so ${call.kind === "cancel" ? "cancelling" : "changing"} it means calling them.`);
  }
  if (closedNow(place)) lines.push(`${opensAt(place)}\nReply to this message when you'd like me to call them to ${task(call)}.`);
  else lines.push(`Shall I call them to ${task(call)}? It takes about 2 minutes.\nReply to this message to go ahead.`);
  if (config.dryRun) lines.push(`_Dry run: the call will go to ${testCallee().label}, not the restaurant._`);
  return lines.join("\n\n");
}

/**
 * Place a call the chat approved, then report the outcome and the next step.
 */
export async function runCall(call: PendingCall): Promise<{ ok: boolean; message: string }> {
  clearPendingCall();
  const place = getPlace(call.placeId);
  if (!place) return { ok: false, message: "I lost track of which place to call." };
  const c = config.booking.contact;
  await status(`📞 Calling ${place.name}…`);

  if (call.kind === "book") {
    const onlinePolicy = await findPolicyOnline(place);
    const report = await callToBook(place, call.slot, c);
    if (report.outcome.outcome === "booked") {
      const bookedTime = report.outcome.bookedTime ?? call.slot.time;
      const slot = { ...call.slot, time: bookedTime, ...(bookedTime !== call.slot.time ? { asked: call.slot.time } : {}) };
      const out = await recordBooking(place, slot, "phone", {
        status: "confirmed",
        policyText: report.outcome.cancellationPolicy ?? onlinePolicy ?? undefined,
        policyChecked: ["the call", place.website && "their website", place.tabelog_url && "Tabelog"].filter(Boolean).join(", "),
        said: report.outcome.summaryEn,
        detail: `${report.outcome.summaryEn}\n\nTranscript:\n${report.transcript.slice(0, 1500)}`,
      }, call.planId);
      return { ok: true, message: out.message };
    }
    return { ok: false, message: outcomeMessage(call, place, report) };
  }

  const r = call.reservationId ? getReservation(call.reservationId) : undefined;
  if (!r) return { ok: false, message: "I couldn't find that booking any more." };

  if (call.kind === "cancel") {
    const report = await callToCancel(r, place, c);
    if (report.outcome.outcome === "cancelled") {
      updateReservation(r.id, { status: "cancelled", notes: [r.notes, call.reason && `cancelled: ${call.reason}`, report.outcome.summaryEn].filter(Boolean).join(" / ") });
      cancelJobs(`res:${r.id}:`);
      if (r.plan_id) updatePlan(r.plan_id, { status: "cancelled" });
      return { ok: true, message: `❌ *Cancelled ${place.name}* (${fmtDate(r.date)} ${r.time}).\n${report.outcome.summaryEn}${config.dryRun ? `\n\n_Dry run: the call went to ${testCallee().label}, not the restaurant._` : ""}` };
    }
    const deadline = policyLine(r);
    return { ok: false, message: `${outcomeMessage(call, place, report)}${deadline ? `\n\n${deadline}` : ""}` };
  }

  const report = await callToModify(r, place, call.slot, c);
  if (report.outcome.outcome === "booked") {
    const updated = updateReservation(r.id, { date: call.slot.date, time: report.outcome.bookedTime ?? call.slot.time, party_size: call.slot.partySize });
    await applyPolicy(updated.id, report.outcome.cancellationPolicy ?? updated.policy_text);
    return { ok: true, message: `✅ *Changed ${place.name}* to ${fmtDate(updated.date)} ${updated.time}, ${updated.party_size} people.` };
  }
  return { ok: false, message: outcomeMessage(call, place, report) };
}

/**
 * What to say after a call that didn't get the job done: what happened, what
 * they said, and an open question. The call stays pending, so "try 19:00" or
 * "try again" places it again (needs a go-ahead like any call).
 */
export function outcomeMessage(call: PendingCall, place: Place, report: CallReport): string {
  const o = report.outcome;
  const name = `*${place.name}*`;
  const what: Record<string, string> = {
    full: `${name} is full at ${call.slot.time}.`,
    declined: `${name} would only take it with ${o.requirements ?? "conditions we don't accept"}, so I said no thanks (seats-only).`,
    busy: `${name}'s line was busy.`,
    no_answer: `Nobody picked up at ${name}.`,
    voicemail: `${name} went to voicemail. I didn't leave a message.`,
    closed: `${name} is closed then.`,
    wrong_number: `That number isn't ${name}'s, so I've stopped using it.`,
    callback: `${name} will call back on ${domesticPhone(config.booking.contact.phone)}. Tell me what they say and I'll note it.`,
    failed: `I couldn't place the call to ${name}.`,
  };
  // A wrong number is never called again (in a dry run the "wrong number" is you, so keep it).
  if (o.outcome === "wrong_number" && !config.dryRun) updatePlace(place.id, { phone: null, note: [place.note, `wrong number ${place.phone} (${fmtDate(now().toISODate()!)})`].filter(Boolean).join(" / ") });
  const retry = !["declined", "wrong_number", "callback"].includes(o.outcome);
  if (retry) setPending({ ...call, alternatives: o.alternativeTimes.length ? o.alternativeTimes : undefined });
  const lines = [
    `❌ ${what[o.outcome] ?? `The call to ${name} ended without a clear answer.`}`,
    o.outcome === "failed" ? (report.failure ?? o.summaryEn) : o.summaryEn,
    o.alternativeTimes.length ? `They offered *${o.alternativeTimes.join(", ")}*.` : "",
    retry ? "Want me to try again, another time, or another option?" : "Want another option?",
    config.dryRun && o.outcome !== "failed" ? `_Dry run: the call went to ${testCallee().label}, not the restaurant._` : "",
  ];
  return lines.filter(Boolean).join("\n\n");
}

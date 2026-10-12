import { DateTime } from "luxon";
import { config, domesticPhone, testCallee } from "../config";
import { kvGet, kvSet } from "../db";
import { getPlace, getReservation, updatePlace, updatePlan, updateReservation } from "../db/repo";
import { cancelJobs, registerJob, schedule } from "../jobs/scheduler";
import { say, status } from "../notify";
import type { Place } from "../types";
import { fmtDate, isOpenFor, now, ZONE } from "../util/time";
import { callToBook, callToCancel, callToModify, type CallReport } from "./phone";
import { applyPolicy, policyLine, recordBooking } from "./service";
import type { Slot } from "./types";
import { findPolicyOnline } from "./policy";

/**
 * Phone calls are tightly controlled: the bot never dials on its own. Every
 * call (book, change, cancel, retry, call back for another time) is first
 * proposed in the chat, stored here as the pending call, and only placed once
 * someone says yes (the agent's place_call tool). After each call the bot
 * reports what happened and proposes the next step, which again needs a yes.
 */

export interface PendingCall {
  kind: "book" | "cancel" | "modify";
  placeId: number;
  slot: Slot;
  planId?: number;
  reservationId?: number;
  reason?: string;
  /** Times the restaurant offered on the last call (for "book 19:00"). */
  alternatives?: string[];
  /** Suggested delay before calling, e.g. 30 when the line was busy. */
  suggestDelayMin?: number;
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
  return `Waiting for a go-ahead to call ${place?.name ?? "?"} to ${task(p)}${p.alternatives?.length ? ` (they offered ${p.alternatives.join(", ")})` : ""}${p.suggestDelayMin ? ` (suggested: in ${p.suggestDelayMin} min)` : ""}.`;
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

/** Store the call and ask for a go-ahead. Returns the message to post. */
export function askToCall(call: PendingCall, place: Place, tried: string[]): string {
  setPending(call);
  const lines: string[] = [];
  if (call.kind === "book") {
    lines.push(tried.length ? `📞 *${place.name}*: the other ways to book didn't work.\n${tried.map((t) => `• ${t}`).join("\n")}` : `📞 *${place.name}* takes bookings by phone.`);
  } else {
    lines.push(`📞 *${place.name}* was booked by phone, so ${call.kind === "cancel" ? "cancelling" : "changing"} it means calling them.`);
  }
  lines.push(`Shall I call them to ${task(call)}? It takes about 2 minutes.`);
  const open = isOpenFor(place.opening_periods, now(), 15);
  const next = open === false ? nextOpening(place) : null;
  if (next) {
    lines.push(`Heads-up: they're closed right now and open ${next.hasSame(now(), "day") ? "at" : next.toFormat("ccc")} ${next.toFormat("HH:mm")}.\nReply *call at ${next.toFormat("HH:mm")}*, *call now*, or *no*.`);
  } else {
    lines.push("Reply *call* to go ahead, or *no*.");
  }
  if (config.dryRun) lines.push(`_Dry run: the call will go to ${testCallee().label}, not the restaurant._`);
  return lines.join("\n\n");
}

/** Schedule an approved call for later ("call at 17:00", "try again in 30 min"). */
export function scheduleCall(call: PendingCall, at: DateTime): string {
  clearPendingCall();
  const place = getPlace(call.placeId)!;
  schedule("phone_call", at, { call, due: at.toISO() }, `call:${call.placeId}:${call.kind}:${at.toISO()}`);
  return `⏰ I'll call *${place.name}* at ${at.setZone(ZONE).toFormat("HH:mm")}${at.hasSame(now(), "day") ? "" : ` on ${at.setZone(ZONE).toFormat("ccc d LLL")}`} to ${task(call)}.`;
}

export function registerCallJobs(): void {
  registerJob("phone_call", async ({ call, due }: { call: PendingCall; due: string }) => {
    const place = getPlace(call.placeId);
    if (!place) return;
    // Missed while the app was off: don't call late without asking again.
    if (Date.now() - Date.parse(due) > 60 * 60_000) {
      setPending(call);
      await say(`I missed the planned call to *${place.name}* (the app was off). Reply *call* to try now, or *no*.`);
      return;
    }
    const out = await runCall(call);
    await say(out.message);
  });
}

/**
 * Place a call someone approved, then report the outcome and the next step.
 * Only the place_call tool, an explicit "call X" request, or a scheduled call
 * the chat approved may reach this.
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
 * What to say after a call that didn't get the job done, and the follow-up
 * call to propose (stored as pending, so a "yes" places it).
 */
export function outcomeMessage(call: PendingCall, place: Place, report: CallReport): string {
  const o = report.outcome;
  const name = `*${place.name}*`;
  const ask = (next: PendingCall, question: string) => {
    setPending(next);
    return question;
  };
  let msg: string;
  switch (o.outcome) {
    case "full":
      if (o.alternativeTimes.length) {
        const alts = o.alternativeTimes;
        msg = `❌ ${name} is full at ${call.slot.time}.\nThey offered *${alts.join(", ")}*.\n\n` + ask({ ...call, alternatives: alts }, `Shall I call back and book ${alts[0]}? Reply *yes*, another time, or *no*.`);
      } else {
        msg = `❌ ${name} is fully booked around ${call.slot.time} on ${fmtDate(call.slot.date)}.\n\nWant another option, or another day?`;
      }
      break;
    case "declined":
      msg = `🚫 ${name} would only take it with ${o.requirements ?? "conditions we don't accept"}. That breaks our seats-only rule, so I said no thanks.\n\nWant another option?`;
      break;
    case "busy":
      msg = `📵 ${name}'s line was busy.\n\n` + ask({ ...call, suggestDelayMin: 30 }, "Shall I try again in 30 minutes? Reply *yes* or *no*.");
      break;
    case "no_answer": {
      const next = isOpenFor(place.opening_periods, now(), 15) === false ? nextOpening(place) : null;
      msg = next
        ? `📵 Nobody picked up at ${name}. They're closed right now and open at ${next.toFormat("HH:mm")}.\n\n` + ask(call, `Shall I try at ${next.plus({ minutes: 15 }).toFormat("HH:mm")}? Reply *yes* or *no*.`)
        : `📵 Nobody picked up at ${name}.\n\n` + ask({ ...call, suggestDelayMin: 60 }, "Shall I try again in an hour? Reply *yes* or *no*.");
      break;
    }
    case "voicemail":
      msg = `📼 ${name} went to voicemail. I didn't leave a message.\n\n` + ask({ ...call, suggestDelayMin: 60 }, "Shall I try again in an hour? Reply *yes* or *no*.");
      break;
    case "closed":
      msg = `🔒 ${name} is closed: ${o.summaryEn}\n\nWant another option, or another day?`;
      break;
    case "wrong_number":
      // In a dry run the "wrong number" is you, so keep the place's number.
      if (!config.dryRun) updatePlace(place.id, { phone: null, note: [place.note, `wrong number ${place.phone} (${fmtDate(now().toISODate()!)})`].filter(Boolean).join(" / ") });
      msg = `☎️ That number isn't ${name}'s, so I've stopped using it.\n\nWant another option?`;
      break;
    case "callback":
      msg = `📞 ${name} will call you back on ${domesticPhone(config.booking.contact.phone)}.\n${o.summaryEn}\n\nTell me what they say and I'll note the booking.`;
      break;
    case "failed":
      msg = `⚠️ I couldn't place the call to ${name}.\n${report.failure ?? o.summaryEn}\n\n` + ask(call, "Say *call again* once that's sorted.");
      break;
    default:
      msg = `🤷 The call to ${name} ended without a clear answer.\n${o.summaryEn}\n\n` + ask(call, "Shall I try again? Reply *yes* or *no*.");
  }
  return msg + (config.dryRun && o.outcome !== "failed" ? `\n\n_Dry run: the call went to ${testCallee().label}, not the restaurant._` : "");
}

/** When the chat answers "call at 17:00" / "in 30 min": the moment to call. */
export function callTime(at: string | undefined, inMinutes: number | undefined): DateTime | null {
  if (inMinutes) return now().plus({ minutes: inMinutes });
  if (at && /^\d{1,2}:\d{2}$/.test(at)) {
    let t = DateTime.fromFormat(at.padStart(5, "0"), "HH:mm", { zone: ZONE }).set({ year: now().year, month: now().month, day: now().day });
    if (t < now()) t = t.plus({ days: 1 });
    return t;
  }
  return null;
}

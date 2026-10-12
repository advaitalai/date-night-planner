import { DateTime } from "luxon";
import { z } from "zod";
import { config, testCallee } from "../config";
import { createReservation, getPlace, getPrefs, getReservation, updatePlace, updatePlan, updateReservation } from "../db/repo";
import { cancelJobs, schedule } from "../jobs/scheduler";
import { extract } from "../llm";
import { say, status } from "../notify";
import type { Place, Reservation } from "../types";
import { fmtDate, freeCancelDeadline, jst, now, ZONE } from "../util/time";
import { email } from "./email";
import { tabelog } from "./tabelog";
import { detectChannel } from "./detect";
import { phone, vapiConfigured } from "./phone";
import { tablecheck } from "./tablecheck";
import { askToCall, runCall, type PendingCall } from "./calls";
import { pickInWindow, windowLabel } from "./window";
import { logAttempt } from "../logbook";
import type { AvailabilityResult, BookingAdapter, BookResult, Slot } from "./types";
import { clientFor } from "../google/auth";
import { BOOKER } from "../google/gmail";

const ADAPTERS: Record<string, BookingAdapter> = { tablecheck, tabelog, email, phone };

/** The adapter that holds an existing reservation (for changes and cancellations). */
export function adapterFor(place: Place, reservation?: Reservation): BookingAdapter | null {
  return ADAPTERS[reservation?.channel ?? place.booking_channel] ?? null;
}

export interface Route {
  channel: "tablecheck" | "tabelog" | "email" | "phone";
  adapter: BookingAdapter;
  /** Status-line phrase while trying this route. */
  doing: string;
}

/**
 * How to book a place, fastest and most predictable first:
 * booking-site automation (TableCheck, Tabelog), then email, then an AI phone call.
 */
export function bookingRoutes(place: Place): Route[] {
  const routes: Route[] = [];
  if (place.tablecheck_slug) routes.push({ channel: "tablecheck", adapter: tablecheck, doing: `Booking ${place.name} on TableCheck (seats only)…` });
  if (place.tabelog_url && place.booking_channel === "tabelog") routes.push({ channel: "tabelog", adapter: tabelog, doing: `Booking ${place.name} on Tabelog…` });
  if (place.booking_email && clientFor(BOOKER)) routes.push({ channel: "email", adapter: email, doing: `Emailing ${place.name}…` });
  // In a dry run the call goes to BOOKING_PHONE, so the place's own number isn't needed.
  if ((place.phone || config.dryRun) && vapiConfigured()) routes.push({ channel: "phone", adapter: phone, doing: `📞 Calling ${place.name} (AI call, a few minutes)…` });
  const only = config.booking.only;
  return only.length ? routes.filter((r) => only.includes(r.channel)) : routes;
}

/** Fill in booking links/emails we haven't looked up yet (done lazily, at booking time). */
async function ensureDetected(place: Place): Promise<Place> {
  if (place.tablecheck_slug || place.tabelog_url || place.booking_email || place.booking_channel !== "unknown") return place;
  const d = await detectChannel(place).catch(() => null);
  return d ? updatePlace(place.id, { booking_channel: d.channel, ...d.patch }) : place;
}

export async function checkAvailability(place: Place, slot: Slot): Promise<AvailabilityResult> {
  const site = bookingRoutes(place).find((r) => r.channel === "tablecheck" || r.channel === "tabelog");
  if (!site) return { status: "unknown", detail: "no booking site to check; it's confirmed when booking" };
  return site.adapter.checkAvailability(place, slot);
}

// ---------- cancellation policy ----------

const PolicySchema = z.object({
  found: z.boolean().describe("Whether the text states a cancellation policy at all"),
  hoursBefore: z.number().nullable().describe("Free cancellation until N hours before the booking"),
  daysBefore: z.number().nullable().describe("Free cancellation until N days before the booking (use with atTime)"),
  atTime: z.string().nullable().describe("HH:mm cut-off time on that day, JST"),
  fee: z.string().nullable().describe("Fee after the deadline, as stated, e.g. '50% of course price', '¥5,000 per person'"),
});

/** Turn policy text into a free-cancel deadline and (re)schedule the reminders. */
export async function applyPolicy(reservationId: number, policyText: string | null): Promise<Reservation> {
  const r = getReservation(reservationId)!;
  let rule: z.infer<typeof PolicySchema> | null = null;
  if (policyText?.trim()) {
    try {
      rule = await extract(
        PolicySchema,
        "Extract the restaurant cancellation policy from the text (Japanese or English). Use only what the text says.",
        `Booking: ${r.date} ${r.time} JST\n\n${policyText}`,
      );
    } catch (err) {
      console.warn("policy extraction failed:", err);
    }
  }
  const { deadline, assumed } = freeCancelDeadline(r.date, r.time, rule?.found ? rule : null);
  const updated = updateReservation(r.id, {
    policy_text: policyText ?? r.policy_text,
    free_cancel_deadline: deadline.toISO(),
    cancel_fee: rule?.fee ?? r.cancel_fee,
    notes: assumed ? "cancellation policy not stated; assuming 24h" : r.notes,
  });
  scheduleReservationJobs(updated);
  return updated;
}

/** Reminders for a live booking. Keys are per reservation so changes replace them. */
export function scheduleReservationJobs(r: Reservation): void {
  cancelJobs(`res:${r.id}:`);
  if (r.status !== "confirmed" && r.status !== "requested") return;
  const t = now();
  if (r.free_cancel_deadline) {
    const deadline = DateTime.fromISO(r.free_cancel_deadline, { zone: ZONE });
    for (const hours of [48, 24]) {
      const at = deadline.minus({ hours });
      if (at > t) schedule("cancel_guard", at, { reservationId: r.id, hours }, `res:${r.id}:guard${hours}:${r.free_cancel_deadline}`);
    }
  }
  const dayOf = jst(r.date, "11:00");
  if (dayOf > t) schedule("dayof_reminder", dayOf, { reservationId: r.id }, `res:${r.id}:dayof:${r.date}`);
  schedule("post_date", jst(r.date, r.time).plus({ hours: 18 }), { reservationId: r.id }, `res:${r.id}:post:${r.date}`);
}

// ---------- book / modify / cancel ----------

export interface BookOutcome {
  ok: boolean;
  reservation?: Reservation;
  message: string;
  /** Waiting for someone to OK a phone call. */
  awaitingCall?: boolean;
}

export interface BookOpts {
  planId?: number;
  notes?: string;
  /** Someone in the chat explicitly said to phone this place. Without it, a phone booking only asks. */
  callApproved?: boolean;
}

/**
 * Book one place, trying its booking routes in order (site, then email). Never
 * moves on to a different place. A phone call is never made without a go-ahead
 * in the chat: if phoning is the way left, this asks first (calls.ts).
 */
export async function bookPlace(place: Place, slot: Slot, opts: BookOpts = {}): Promise<BookOutcome> {
  place = await ensureDetected(place);
  const routes = bookingRoutes(place);
  if (!routes.length) return { ok: false, message: `I don't have a way to book *${place.name}* (no booking site, email or phone number I can use).` };
  const prefs = getPrefs();
  const notes = [opts.notes, prefs.dietary && `Dietary: ${prefs.dietary}`].filter(Boolean).join(" / ") || undefined;

  const tried: string[] = [];
  for (const r of routes) {
    if (r.channel === "phone") {
      const call: PendingCall = { kind: "book", placeId: place.id, slot, planId: opts.planId };
      return opts.callApproved ? runCall(call) : { ok: false, awaitingCall: true, message: askToCall(call, place, tried) };
    }
    await status(r.doing);
    let result: BookResult;
    try {
      result = await r.adapter.book(place, slot, config.booking.contact, notes);
    } catch (err) {
      result = { status: "failed", detail: (err as Error).message };
    }
    // Full at the asked time but free inside their window: book that time, same channel, no need to ask.
    const inWin = result.status === "failed" && result.full && !slot.asked ? pickInWindow(result.alternatives, slot) : null;
    if (inWin) {
      const moved = { ...slot, time: inWin, asked: slot.time };
      await status(`${slot.time} is full; booking ${inWin} (inside your window)…`);
      try {
        const retry = await r.adapter.book(place, moved, config.booking.contact, notes);
        logAttempt({ placeId: place.id, placeName: place.name, date: moved.date, time: moved.time, channel: r.channel, result: retry.status === "failed" ? "failed" : retry.status, detail: retry.detail });
        if (retry.status !== "failed") return recordBooking(place, moved, r.channel, retry, opts.planId);
      } catch {
        // fall through to the full message
      }
    }
    logAttempt({ placeId: place.id, placeName: place.name, date: slot.date, time: slot.time, channel: r.channel, result: result.status === "failed" ? (result.full ? "full" : "failed") : result.status, detail: result.detail });
    if (result.status !== "failed") return recordBooking(place, slot, r.channel, result, opts.planId);
    console.log(`[booking] ${place.name} via ${r.channel} failed: ${result.detail}`);
    tried.push(`${CHANNEL_NAME[r.channel]} didn't work (${friendlyError(result.detail)})`);
    // A definite "that time is full" ends the attempt; trying other channels won't free a table.
    if (result.full) {
      const near = nearbyTimes(result.alternatives, slot.time);
      const alts = near.length ? `\nFree that evening: *${near.join(", ")}*.` : "\nNothing free that evening.";
      const ask = near.length ? "Want one of those times, or another option?" : "Want another option, or another day?";
      return { ok: false, message: `❌ *${place.name}* is full at ${slot.time} on ${fmtDate(slot.date)}.${alts}\n\n${ask}` };
    }
  }
  return { ok: false, message: `❌ I couldn't book *${place.name}* for ${fmtDate(slot.date)} ${slot.time}.\n\n${tried.map((t) => `• ${t}`).join("\n")}\n\nWant to try another option?` };
}

/** Up to 4 free times closest to the asked time, in order (dinner hours only). */
export function nearbyTimes(times: string[] | undefined, asked: string): string[] {
  const m = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  return (times ?? [])
    .filter((t) => /^\d{2}:\d{2}$/.test(t) && m(t) >= 17 * 60 && m(t) <= 21 * 60 + 30)
    .sort((a, b) => Math.abs(m(a) - m(asked)) - Math.abs(m(b) - m(asked)))
    .slice(0, 4)
    .sort();
}

/**
 * One short line for the chat from whatever a booking step reported. Site
 * messages ("selected time is unavailable") pass through; crashes and stack
 * traces become a plain reason, with the details left in the log.
 */
export function friendlyError(detail: string | undefined): string {
  const first = (detail ?? "").split("\n")[0].trim();
  if (!first) return "unknown error";
  if (/executable doesn't exist|launchPersistentContext|browserType|playwright/i.test(first)) return "the booking browser isn't set up on this machine";
  if (/timeout|timed out/i.test(first)) return "the booking page took too long to respond";
  if (/net::|ECONN|ENOTFOUND|fetch failed|socket/i.test(first)) return "couldn't reach the booking site";
  if (/locator|selector|waiting for|strict mode/i.test(first)) return "the booking page looked different from usual";
  return first.length > 140 ? `${first.slice(0, 137)}…` : first;
}

const CHANNEL_NAME: Record<Route["channel"], string> = { tablecheck: "TableCheck", tabelog: "Tabelog", email: "Email", phone: "The phone call" };

/** Save a successful booking, schedule its reminders, and write the confirmation. */
export async function recordBooking(place: Place, slot: Slot, channel: Route["channel"], result: BookResult, planId?: number): Promise<BookOutcome> {
  // A dry run on a booking site stops before the final confirm: nothing is booked, so nothing is recorded.
  if (result.detail?.startsWith("DRY_RUN")) {
    const how = { tablecheck: "TableCheck", tabelog: "Tabelog", email: "email", phone: "phone" }[channel];
    return { ok: true, message: `🧪 *Dry run: ${place.name} would be booked*\n${fmtDate(slot.date)}, ${slot.time}, ${slot.partySize} people, on ${how}.\n\n_${how} accepted everything; I stopped before the final confirm. Nothing is booked._` };
  }
  const reservation = createReservation({
    plan_id: planId ?? null,
    place_id: place.id,
    channel,
    status: result.status === "requested" ? "requested" : "confirmed",
    date: slot.date,
    time: slot.time,
    party_size: slot.partySize,
    external_ref: result.externalRef ?? null,
    manage_url: result.manageUrl ?? null,
    gmail_thread_id: result.gmailThreadId ?? null,
    policy_text: result.policyText ?? null,
    free_cancel_deadline: null,
    cancel_fee: null,
    notes: result.detail?.slice(0, 2000) ?? null,
  });
  const withPolicy = await applyPolicy(reservation.id, result.policyText ?? null);
  if (planId) updatePlan(planId, { status: result.status === "confirmed" ? "booked" : "booking", chosen_place_id: place.id });

  const when = `${fmtDate(slot.date)}, ${slot.time}, ${slot.partySize} people${slot.asked && slot.asked !== slot.time ? `\n_${slot.asked} was taken; ${slot.time} is inside your ${windowLabel({ ...slot, time: slot.asked })} window._` : ""}`;
  const how = { tablecheck: "on TableCheck", tabelog: "on Tabelog", email: "by email", phone: `by phone, under *${config.call.bookingName}*` }[channel];
  const mock = config.dryRun && channel === "phone" ? `\n\n_Dry run: the call went to ${testCallee().label}, not the restaurant._` : "";
  const message =
    result.status === "confirmed"
      ? [`✅ *Booked ${place.name}*`, `${when}, ${how}${result.externalRef ? `\nRef ${result.externalRef}` : ""}`, policyLine(withPolicy)].filter(Boolean).join("\n\n") + mock
      : [`📨 *Reservation requested at ${place.name}*`, `${when}, ${how}`, "I'll post here when they confirm."].join("\n\n");
  return { ok: true, reservation: withPolicy, message };
}

export function policyLine(r: Reservation): string {
  if (!r.free_cancel_deadline) return "";
  const d = DateTime.fromISO(r.free_cancel_deadline, { zone: ZONE }).toFormat("ccc d LLL HH:mm");
  const assumed = r.notes?.includes("assuming 24h") ? " (policy not stated, assuming 24h)" : "";
  return `Free cancellation until ${d}${assumed}${r.cancel_fee ? `; after that: ${r.cancel_fee}` : ""}.`;
}

export async function cancelReservation(id: number, reason?: string, opts: { callApproved?: boolean } = {}): Promise<string> {
  const r = getReservation(id);
  if (!r || (r.status !== "confirmed" && r.status !== "requested")) return `No active reservation #${id}.`;
  const place = getPlace(r.place_id)!;
  if (r.channel === "phone") {
    const call: PendingCall = { kind: "cancel", placeId: place.id, slot: { date: r.date, time: r.time, partySize: r.party_size }, reservationId: r.id, reason };
    return opts.callApproved ? (await runCall(call)).message : askToCall(call, place, []);
  }
  const adapter = adapterFor(place, r);
  if (!adapter) return `I can't cancel ${place.name} myself.`;
  const res = await adapter.cancel(r, place, config.booking.contact).catch((err: Error) => ({ ok: false, detail: err.message }));
  if (!res.ok) return `⚠️ Couldn't cancel ${place.name}: ${res.detail}. Please handle it manually before the deadline.`;
  updateReservation(id, { status: "cancelled", notes: [r.notes, reason && `cancelled: ${reason}`].filter(Boolean).join(" / ") });
  cancelJobs(`res:${id}:`);
  if (r.plan_id) updatePlan(r.plan_id, { status: "cancelled" });
  return `❌ Cancelled ${place.name} (${fmtDate(r.date)} ${r.time}).${res.detail ? ` ${res.detail}` : ""}`;
}

export async function modifyReservation(id: number, change: Partial<Slot>, opts: { callApproved?: boolean } = {}): Promise<string> {
  const r = getReservation(id);
  if (!r || (r.status !== "confirmed" && r.status !== "requested")) return `No active reservation #${id}.`;
  const place = getPlace(r.place_id)!;
  const slot: Slot = { date: change.date ?? r.date, time: change.time ?? r.time, partySize: change.partySize ?? r.party_size };
  if (r.channel === "phone") {
    const call: PendingCall = { kind: "modify", placeId: place.id, slot, reservationId: r.id };
    return opts.callApproved ? (await runCall(call)).message : askToCall(call, place, []);
  }
  const adapter = adapterFor(place, r);
  if (!adapter) return `I can't change ${place.name} myself.`;

  if (place.booking_channel !== "email") {
    const avail = await adapter.checkAvailability(place, slot);
    if (avail.status === "unavailable") {
      return `${place.name} has no table at ${slot.time} on ${fmtDate(slot.date)}.${avail.alternatives?.length ? ` Free nearby: ${avail.alternatives.join(", ")}.` : ""}`;
    }
  }
  const res = await adapter.modify(r, place, slot, config.booking.contact).catch((err: Error) => ({ ok: false, detail: err.message }));
  if (!res.ok) return `⚠️ Couldn't change ${place.name}: ${res.detail}`;
  const updated = updateReservation(id, {
    date: slot.date,
    time: slot.time,
    party_size: slot.partySize,
    status: place.booking_channel === "email" ? "requested" : "confirmed",
    external_ref: place.booking_channel === "email" ? r.external_ref : (res.detail ?? r.external_ref),
  });
  await applyPolicy(updated.id, updated.policy_text);
  return place.booking_channel === "email"
    ? `📨 Asked ${place.name} to move us to ${fmtDate(slot.date)} ${slot.time} (${slot.partySize}). I'll confirm when they reply.`
    : `✅ Changed ${place.name} to ${fmtDate(slot.date)} ${slot.time}, ${slot.partySize} people.`;
}

/** Book, and announce the outcome in the group. */
export async function bookAndAnnounce(place: Place, slot: Slot, opts: BookOpts = {}): Promise<BookOutcome> {
  const out = await bookPlace(place, slot, opts);
  await say(out.message);
  return out;
}

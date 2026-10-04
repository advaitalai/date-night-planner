import { DateTime } from "luxon";
import { z } from "zod";
import { applyPolicy, policyLine } from "../booking/service";
import { sameName } from "../booking/detect";
import { db, kvGet, kvSet } from "../db";
import { getPlace, getPlan, getReservation, updateReservation } from "../db/repo";
import { myAddress, searchMail, threadMessages } from "../google/gmail";
import { extract } from "../llm";
import { say } from "../notify";
import { bookOption } from "../plans/decide";
import type { Reservation } from "../types";
import { fmtDate } from "../util/time";

const ReplySchema = z.object({
  kind: z.enum(["confirmed", "declined", "alternative", "question", "cancel_ack", "change_ack", "other"]),
  alternativeTimes: z.array(z.string()).describe("HH:mm times the restaurant offered instead"),
  policyText: z.string().nullable().describe("Cancellation policy text quoted from the email, if any"),
  summaryEn: z.string().describe("One-sentence English summary for the couple"),
});

const PlatformSchema = z.object({
  kind: z.enum(["confirmation", "cancellation", "change", "reminder", "request_received", "other"]),
  restaurantName: z.string().nullable(),
  date: z.string().nullable().describe("YYYY-MM-DD"),
  time: z.string().nullable().describe("HH:mm"),
  reference: z.string().nullable(),
  manageUrl: z.string().nullable().describe("URL to view/change/cancel the booking"),
  policyText: z.string().nullable(),
});

const NO_REPLY_HOURS = 24;

/** Restaurant replies on email booking threads. */
async function checkEmailThreads(me: string): Promise<void> {
  const open = db()
    .prepare("SELECT * FROM reservations WHERE channel = 'email' AND status IN ('requested','confirmed') AND gmail_thread_id IS NOT NULL")
    .all() as Reservation[];

  for (const r of open) {
    const msgs = await threadMessages(r.gmail_thread_id!);
    const lastSeenIdx = r.last_seen_message_id ? msgs.findIndex((m) => m.id === r.last_seen_message_id) : -1;
    const fresh = msgs.slice(lastSeenIdx + 1).filter((m) => !m.from.includes(me));
    if (msgs.length) updateReservation(r.id, { last_seen_message_id: msgs[msgs.length - 1].id });
    const place = getPlace(r.place_id)!;

    if (!fresh.length) {
      const age = DateTime.now().diff(DateTime.fromSQL(r.created_at ?? "", { zone: "utc" }), "hours").hours;
      if (r.status === "requested" && age > NO_REPLY_HOURS && !kvGet(`noreply:${r.id}`, false)) {
        kvSet(`noreply:${r.id}`, true);
        await fallback(r, `${place.name} hasn't replied in ${NO_REPLY_HOURS}h`);
      }
      continue;
    }

    for (const m of fresh) {
      const reply = await extract(
        ReplySchema,
        "Classify a Japanese restaurant's email reply about a reservation request. Quote any cancellation policy verbatim.",
        `Our request: ${r.date} ${r.time}, ${r.party_size} people.\n\nTheir reply:\n${m.text}`,
      );
      switch (reply.kind) {
        case "confirmed": {
          const updated = await applyPolicy(updateReservation(r.id, { status: "confirmed" }).id, reply.policyText ?? r.policy_text);
          await say(`✅ ${place.name} confirmed ${fmtDate(r.date)} ${r.time}. ${policyLine(updated)}`);
          break;
        }
        case "declined":
          updateReservation(r.id, { status: "failed", notes: reply.summaryEn });
          await fallback(r, `${place.name} declined: ${reply.summaryEn}`);
          break;
        case "alternative":
          await say(`${place.name} can't do ${r.time} but offered ${reply.alternativeTimes.join(", ") || "other times"}. Want one of those? ("move to 19:30")`);
          break;
        case "cancel_ack":
          updateReservation(r.id, { status: "cancelled" });
          await say(`${place.name} acknowledged the cancellation.`);
          break;
        default:
          if (reply.policyText) await applyPolicy(r.id, reply.policyText);
          await say(`📩 ${place.name} replied: ${reply.summaryEn}`);
      }
    }
  }
}

/** Email booking didn't work out: move to the next option of the plan, if there is one. */
async function fallback(r: Reservation, why: string): Promise<void> {
  const plan = r.plan_id ? getPlan(r.plan_id) : undefined;
  const nextIdx = plan?.options.findIndex((o) => o.placeId !== r.place_id && o.availability === "available") ?? -1;
  if (!plan || nextIdx < 0) {
    await say(`${why}. Want me to find something else for ${fmtDate(r.date)}?`);
    return;
  }
  updateReservation(r.id, { status: "failed" });
  await say(`${why}. Moving on to *${plan.options[nextIdx].name}*…`);
  // bookOption only books proposed plans; reopen it.
  db().prepare("UPDATE plans SET status = 'proposed' WHERE id = ?").run(plan.id);
  await bookOption(plan.id, nextIdx);
}

/** TableCheck / Tabelog emails: fill in references, manage links and policies. */
async function checkPlatformEmails(): Promise<void> {
  const seen = new Set(kvGet<string[]>("platform_mail_seen", []));
  const mails = await searchMail("from:(tablecheck.com OR tabelog.com) newer_than:3d", 15);
  for (const m of mails.filter((m) => !seen.has(m.id))) {
    seen.add(m.id);
    const info = await extract(PlatformSchema, "Extract reservation details from a booking-platform email (Japanese or English).", `Subject: ${m.subject}\n\n${m.text}`);
    if (!info.date) continue;
    const candidates = db()
      .prepare("SELECT * FROM reservations WHERE date = ? AND status IN ('requested','confirmed')")
      .all(info.date) as Reservation[];
    const r = candidates.find((c) => !info.restaurantName || sameName(getPlace(c.place_id)!.name, info.restaurantName));
    if (!r) continue;
    const place = getPlace(r.place_id)!;
    const patch: Partial<Reservation> = {};
    if (info.reference) patch.external_ref = info.reference;
    if (info.manageUrl) patch.manage_url = info.manageUrl;
    if (info.kind === "confirmation" && r.status === "requested") patch.status = "confirmed";
    if (info.kind === "cancellation") patch.status = "cancelled";
    const updated = updateReservation(r.id, patch);
    if (info.policyText) await applyPolicy(r.id, info.policyText);
    if (patch.status === "confirmed") await say(`✅ ${place.name} confirmed the booking for ${fmtDate(r.date)} ${r.time}. ${policyLine(getReservation(r.id)!)}`);
    if (patch.status === "cancelled" && updated) await say(`${place.name}: cancellation confirmed by email.`);
  }
  kvSet("platform_mail_seen", [...seen].slice(-500));
}

export async function gmailWatch(): Promise<void> {
  let me: string;
  try {
    me = await myAddress();
  } catch {
    return; // Gmail not connected yet
  }
  await checkEmailThreads(me);
  await checkPlatformEmails();
}

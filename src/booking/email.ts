import { DateTime } from "luxon";
import { config, domesticPhone, intlPhone, type Contact } from "../config";
import { sendEmail } from "../google/gmail";
import type { Place, Reservation } from "../types";
import { ZONE } from "../util/time";
import type { AvailabilityResult, BookingAdapter, BookResult, ChangeResult, Slot } from "./types";

/**
 * Email bookings. Messages are fixed, polite templates, Japanese then English (no LLM
 * writing, so nothing gets invented). Replies are read and classified by the
 * Gmail watcher job. In DRY_RUN they go to the booking email instead of the
 * restaurant.
 */

const WEEKDAYS_JA = ["月", "火", "水", "木", "金", "土", "日"];

export function jaDate(date: string, time: string): string {
  const d = DateTime.fromISO(date, { zone: ZONE });
  return `${d.year}年${d.month}月${d.day}日（${WEEKDAYS_JA[d.weekday - 1]}）${time}`;
}

export function enDate(date: string, time: string): string {
  return `${DateTime.fromISO(date, { zone: ZONE }).setLocale("en").toFormat("cccc d LLLL yyyy")}, ${time}`;
}

/** Japanese name first, e.g. "アドヴァイト（Advait）". */
function jaName(c: Contact): string {
  return c.nameKana ? `${c.nameKana}（${c.name}）` : c.name;
}

function signature(c: Contact): string {
  return [jaName(c), domesticPhone(c.phone), c.email].filter(Boolean).join("\n");
}

/** Every email is Japanese first, then the same message in English. */
function bilingual(ja: string, en: string, c: Contact): string {
  return `${ja}\n\n${signature(c)}\n\n――――― English ―――――\n\n${en}\n\n${c.name}\n${intlPhone(c.phone)}\n${c.email}`;
}

export function requestEmail(place: Place, slot: Slot, c: Contact, notes?: string) {
  const ja = `${place.name} ご担当者様

突然のご連絡失礼いたします。${jaName(c)}と申します。
下記の内容で予約をお願いできますでしょうか。

・日時：${jaDate(slot.date, slot.time)}〜
・人数：${slot.partySize}名
・お名前：${jaName(c)}
・電話番号：${domesticPhone(c.phone)}${notes ? `\n・備考：${notes}` : ""}

ご都合が悪い場合は、前後で空いているお時間をお知らせいただけますと幸いです。
あわせて、キャンセルポリシー（キャンセル料が発生する期限）についてもお教えいただけますでしょうか。

何卒よろしくお願いいたします。`;
  const en = `Dear ${place.name} team,

I would like to request a reservation:

- Date & time: ${enDate(slot.date, slot.time)}
- Party size: ${slot.partySize}
- Name: ${c.name}
- Phone: ${intlPhone(c.phone)}${notes ? `\n- Notes: ${notes}` : ""}

If that time isn't available, could you let me know nearby times that are free?
Could you also tell me your cancellation policy (when cancellation fees apply)?

Thank you very much.`;
  return {
    subject: `【ご予約のお願い / Reservation request】${jaDate(slot.date, slot.time)} ${slot.partySize}名 ${c.name}`,
    body: bilingual(ja, en, c),
  };
}

export function changeEmail(place: Place, r: Reservation, slot: Slot, c: Contact) {
  const ja = `${place.name} ご担当者様

いつもお世話になっております。${jaName(c)}です。
${jaDate(r.date, r.time)}・${r.party_size}名で予約しておりますが、下記に変更をお願いできますでしょうか。

・変更後の日時：${jaDate(slot.date, slot.time)}〜
・変更後の人数：${slot.partySize}名

難しい場合はお知らせください。何卒よろしくお願いいたします。`;
  const en = `Dear ${place.name} team,

I have a reservation for ${r.party_size} on ${enDate(r.date, r.time)}. Could you change it to:

- Date & time: ${enDate(slot.date, slot.time)}
- Party size: ${slot.partySize}

Please let me know if that isn't possible. Thank you.`;
  return { subject: `【予約変更のお願い / Change request】${c.name}`, body: bilingual(ja, en, c) };
}

export function cancelEmail(place: Place, r: Reservation, c: Contact) {
  const ja = `${place.name} ご担当者様

いつもお世話になっております。${jaName(c)}です。
大変申し訳ございませんが、${jaDate(r.date, r.time)}・${r.party_size}名の予約をキャンセルさせていただけますでしょうか。

ご迷惑をおかけし申し訳ございません。お手数ですが、ご確認のご返信をいただけますと幸いです。`;
  const en = `Dear ${place.name} team,

I'm very sorry, but I need to cancel my reservation for ${r.party_size} on ${enDate(r.date, r.time)}.
Apologies for the inconvenience — could you reply to confirm the cancellation?`;
  return { subject: `【予約キャンセルのご連絡 / Cancellation】${jaDate(r.date, r.time)} ${c.name}`, body: bilingual(ja, en, c) };
}

function recipient(place: Place, c: Contact): { to: string; prefix: string } {
  if (config.dryRun) return { to: c.email, prefix: `[DRY RUN — would go to ${place.booking_email}] ` };
  return { to: place.booking_email!, prefix: "" };
}

export const email: BookingAdapter = {
  channel: "email",

  async checkAvailability(): Promise<AvailabilityResult> {
    return { status: "unknown", detail: "email-only restaurant; availability is confirmed by reply" };
  },

  async book(place: Place, slot: Slot, c: Contact, notes?: string): Promise<BookResult> {
    if (!place.booking_email) return { status: "failed", detail: "no booking email on file" };
    const { subject, body } = requestEmail(place, slot, c, notes);
    const { to, prefix } = recipient(place, c);
    const sent = await sendEmail({ to, subject: prefix + subject, body });
    return { status: "requested", gmailThreadId: sent.threadId, detail: `emailed ${to}` };
  },

  async modify(r: Reservation, place: Place, slot: Slot, c: Contact): Promise<ChangeResult> {
    if (!place.booking_email) return { ok: false, detail: "no booking email on file" };
    const { subject, body } = changeEmail(place, r, slot, c);
    const { to, prefix } = recipient(place, c);
    await sendEmail({ to, subject: prefix + subject, body, threadId: r.gmail_thread_id ?? undefined });
    return { ok: true, detail: "change requested by email; waiting for the reply" };
  },

  async cancel(r: Reservation, place: Place, c: Contact): Promise<ChangeResult> {
    if (!place.booking_email) return { ok: false, detail: "no booking email on file" };
    const { subject, body } = cancelEmail(place, r, c);
    const { to, prefix } = recipient(place, c);
    await sendEmail({ to, subject: prefix + subject, body, threadId: r.gmail_thread_id ?? undefined });
    return { ok: true, detail: "cancellation emailed; waiting for the restaurant to acknowledge" };
  },
};

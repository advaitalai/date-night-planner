import { DateTime } from "luxon";
import { config, type Contact } from "../config";
import { sendEmail } from "../google/gmail";
import type { Place, Reservation } from "../types";
import { ZONE } from "../util/time";
import type { AvailabilityResult, BookingAdapter, BookResult, ChangeResult, Slot } from "./types";

/**
 * Email bookings. Messages are fixed, polite Japanese templates (no LLM
 * writing, so nothing gets invented). Replies are read and classified by the
 * Gmail watcher job. In DRY_RUN they go to the booking email instead of the
 * restaurant.
 */

const WEEKDAYS_JA = ["月", "火", "水", "木", "金", "土", "日"];

export function jaDate(date: string, time: string): string {
  const d = DateTime.fromISO(date, { zone: ZONE });
  return `${d.year}年${d.month}月${d.day}日（${WEEKDAYS_JA[d.weekday - 1]}）${time}`;
}

function signature(c: Contact): string {
  return [c.name, [c.phone, c.email].filter(Boolean).join(" / ")].filter(Boolean).join("\n");
}

export function requestEmail(place: Place, slot: Slot, c: Contact, notes?: string) {
  return {
    subject: `【ご予約のお願い】${jaDate(slot.date, slot.time)} ${slot.partySize}名 ${c.name}`,
    body: `${place.name} ご担当者様

突然のご連絡失礼いたします。${c.name}と申します。
下記の内容で予約をお願いできますでしょうか。

・日時：${jaDate(slot.date, slot.time)}〜
・人数：${slot.partySize}名
・お名前：${c.name}${c.nameKana ? `（${c.nameKana}）` : ""}
・電話番号：${c.phone}${notes ? `\n・備考：${notes}` : ""}

ご都合が悪い場合は、前後で空いているお時間をお知らせいただけますと幸いです。
あわせて、キャンセルポリシー（キャンセル料が発生する期限）についてもお教えいただけますでしょうか。

何卒よろしくお願いいたします。

${signature(c)}`,
  };
}

export function changeEmail(place: Place, r: Reservation, slot: Slot, c: Contact) {
  return {
    subject: `【予約変更のお願い】${c.name}`,
    body: `${place.name} ご担当者様

いつもお世話になっております。${c.name}です。
${jaDate(r.date, r.time)}・${r.party_size}名で予約しておりますが、下記に変更をお願いできますでしょうか。

・変更後の日時：${jaDate(slot.date, slot.time)}〜
・変更後の人数：${slot.partySize}名

難しい場合はお知らせください。何卒よろしくお願いいたします。

${signature(c)}`,
  };
}

export function cancelEmail(place: Place, r: Reservation, c: Contact) {
  return {
    subject: `【予約キャンセルのご連絡】${jaDate(r.date, r.time)} ${c.name}`,
    body: `${place.name} ご担当者様

いつもお世話になっております。${c.name}です。
大変申し訳ございませんが、${jaDate(r.date, r.time)}・${r.party_size}名の予約をキャンセルさせていただけますでしょうか。

ご迷惑をおかけし申し訳ございません。お手数ですが、ご確認のご返信をいただけますと幸いです。

${signature(c)}`,
  };
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

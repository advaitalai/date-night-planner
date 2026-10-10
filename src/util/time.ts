import { DateTime } from "luxon";
import type { OpeningPeriod } from "../types";

export const ZONE = "Asia/Tokyo";

export function now(): DateTime {
  return DateTime.now().setZone(ZONE);
}

export function jst(date: string, time: string): DateTime {
  return DateTime.fromISO(`${date}T${time}`, { zone: ZONE });
}

/**
 * The next occurrence of `weekday` (luxon: 1 = Mon ... 7 = Sun) strictly after
 * `from`'s calendar day, as YYYY-MM-DD.
 */
export function nextWeekday(from: DateTime, weekday: number): string {
  let d = from.setZone(ZONE).startOf("day").plus({ days: 1 });
  while (d.weekday !== weekday) d = d.plus({ days: 1 });
  return d.toISODate()!;
}

/** The next moment at weekday+time strictly after `from`. */
export function nextWeeklyMoment(from: DateTime, weekday: number, time: string): DateTime {
  const [h, m] = time.split(":").map(Number);
  let d = from.setZone(ZONE).set({ hour: h, minute: m, second: 0, millisecond: 0 });
  while (d.weekday !== weekday || d <= from) d = d.plus({ days: 1 }).set({ hour: h, minute: m });
  return d;
}

/**
 * The date-night date a planning round starting at `from` targets: the first
 * `dateWeekday` after the kickoff. With a Saturday kickoff and Wednesday dates
 * that's the coming Wednesday, 4 days later.
 */
export function targetDateFor(from: DateTime, dateWeekday: number): string {
  return nextWeekday(from, dateWeekday);
}

const WEEK_MIN = 7 * 24 * 60;

/** Minutes since Sunday 00:00, matching the Places API day numbering (0 = Sunday). */
function weekMinute(day: number, hour: number, minute: number): number {
  return day * 24 * 60 + hour * 60 + minute;
}

/**
 * Whether a place is open for the whole window [start, start + durationMin].
 * Returns null when opening hours are unknown. Handles periods that cross
 * midnight and the Sunday→Monday week wrap; a period with no close is 24/7.
 */
export function isOpenFor(periods: OpeningPeriod[] | null, start: DateTime, durationMin = 90): boolean | null {
  if (!periods || periods.length === 0) return null;
  const s = start.setZone(ZONE);
  const startMin = weekMinute(s.weekday % 7, s.hour, s.minute);
  const endMin = startMin + durationMin;
  for (const p of periods) {
    if (!p.close) return true;
    const o = weekMinute(p.open.day, p.open.hour, p.open.minute);
    let c = weekMinute(p.close.day, p.close.hour, p.close.minute);
    if (c <= o) c += WEEK_MIN;
    for (const shift of [0, WEEK_MIN, -WEEK_MIN]) {
      if (startMin + shift >= o && endMin + shift <= c) return true;
    }
  }
  return false;
}

export interface CancelRule {
  /** Free cancellation until this many hours before the booking. */
  hoursBefore?: number | null;
  /** Or: free until `daysBefore` days before, at `atTime` (HH:mm JST) on that day. */
  daysBefore?: number | null;
  atTime?: string | null;
}

/**
 * Last moment a reservation can be cancelled for free. With no usable rule,
 * assume 24 hours (a common default in Tokyo) and let the caller say so.
 */
export function freeCancelDeadline(date: string, time: string, rule: CancelRule | null): { deadline: DateTime; assumed: boolean } {
  const start = jst(date, time);
  if (rule?.daysBefore != null) {
    const [h, m] = (rule.atTime ?? "23:59").split(":").map(Number);
    return { deadline: start.minus({ days: rule.daysBefore }).set({ hour: h, minute: m, second: 0 }), assumed: false };
  }
  if (rule?.hoursBefore != null) return { deadline: start.minus({ hours: rule.hoursBefore }), assumed: false };
  return { deadline: start.minus({ hours: 24 }), assumed: true };
}

export function fmtDate(date: string): string {
  return DateTime.fromISO(date, { zone: ZONE }).toFormat("ccc d LLL");
}

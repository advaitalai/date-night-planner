import { getPrefs } from "../db/repo";
import type { Slot } from "./types";

/**
 * The time window a booking may land in without asking: from the asked time
 * to `latest` (set from a range they gave in chat, e.g. "6 to 7:30 all good"),
 * else the asked time plus prefs.flexLaterMin (30 by default). Later only.
 */

const toMin = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};
const toTime = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

export function latestOk(slot: Slot): string {
  if (slot.latest && toMin(slot.latest) >= toMin(slot.time)) return slot.latest;
  return toTime(toMin(slot.time) + getPrefs().flexLaterMin);
}

export function inWindow(time: string, slot: Slot): boolean {
  const t = toMin(time);
  return t >= toMin(slot.time) && t <= toMin(latestOk(slot));
}

/** The earliest offered time inside the window, if any. */
export function pickInWindow(times: string[] | undefined, slot: Slot): string | null {
  return (times ?? []).filter((t) => /^\d{1,2}:\d{2}$/.test(t) && inWindow(t, slot)).sort((a, b) => toMin(a) - toMin(b))[0] ?? null;
}

/** "18:30–19:00" for messages. */
export function windowLabel(slot: Slot): string {
  const end = latestOk(slot);
  return end === slot.time ? slot.time : `${slot.time}–${end}`;
}

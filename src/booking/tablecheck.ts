import { DateTime } from "luxon";
import type { Page } from "playwright-core";
import { config, intlPhone, type Contact } from "../config";
import type { Place, Reservation } from "../types";
import { jst, ZONE } from "../util/time";
import { withPage } from "./browser";
import type { AvailabilityResult, BookingAdapter, BookResult, ChangeResult, Slot } from "./types";

/**
 * TableCheck.
 *
 * Availability and search use TableCheck's public diner-facing endpoints (the
 * same ones the open-source nbw/tc-mcp server uses). Booking, changes and
 * cancellations drive the diner web flow in a headless browser (as a guest,
 * or logged in if credentials are set), because the Booking API is only
 * offered to venues.
 *
 * The browser steps use text/role locators rather than CSS classes so small
 * redesigns don't break them, but they still need checking against the live
 * site; DRY_RUN stops before the final confirm click.
 */

const API = "https://production.tablecheck.com/v2";
const SHOP_UNIVERSE_ID = "57e0b91744aea12988000001";

export interface TcShop {
  slug: string;
  name: string;
  cuisines: string[];
  tags: string[];
  lat: number | null;
  lng: number | null;
  budgetDinnerAvg: number | null;
  availableDates: string[];
}

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`TableCheck ${res.status} for ${url}`);
  return res.json();
}

/** Text search for shop slugs by name. */
export async function tcAutocomplete(text: string): Promise<{ slug: string; name: string }[]> {
  const q = new URLSearchParams({ shop_universe_id: SHOP_UNIVERSE_ID, locale: "en", text });
  type Hit = { text?: string; text_translations?: { locale: string; translation: string }[]; payload?: { shop_slug?: string } };
  const data = (await getJson(`${API}/autocomplete?${q}`)) as { shops?: Hit[] };
  return (data.shops ?? [])
    .filter((s) => s.payload?.shop_slug)
    .map((s) => ({
      slug: s.payload!.shop_slug!,
      // Newer responses carry names only in text_translations.
      name: s.text ?? s.text_translations?.find((t) => t.locale === "en")?.translation ?? s.text_translations?.[0]?.translation ?? s.payload!.shop_slug!,
    }));
}

/** Shops near a point with online availability for the slot. Used for discovery. */
export async function tcSearchNear(lat: number, lng: number, slot: Slot, opts: { distance?: string; cuisines?: string[] } = {}): Promise<TcShop[]> {
  const q = new URLSearchParams({
    shop_universe_id: SHOP_UNIVERSE_ID,
    availability_days_limit: "1",
    availability_format: "date",
    service_mode: "dining",
    venue_type: "all",
    per_page: "50",
    include_ids: "true",
    geo_latitude: String(lat),
    geo_longitude: String(lng),
    geo_distance: opts.distance ?? "3km",
    date_min: slot.date,
    date_max: slot.date,
    num_people: String(slot.partySize),
    time: slot.time,
    availability_mode: "same_meal_time",
  });
  for (const c of opts.cuisines ?? []) q.append("cuisines[]", c);
  const data = (await getJson(`${API}/shop_search?${q}`)) as { shops?: Record<string, unknown>[] };
  return (data.shops ?? []).map(parseShop);
}

export function parseShop(s: Record<string, unknown>): TcShop {
  const names = s.name as string[] | string | undefined;
  const geocode = s.geocode as { lat?: number; lon?: number } | undefined;
  const translations = (s.name_translations as { translation: string; locale: string }[] | undefined) ?? [];
  return {
    slug: String(s.slug),
    name: translations.find((t) => t.locale === "en")?.translation ?? (Array.isArray(names) ? names[0] : (names ?? String(s.slug))),
    cuisines: (s.cuisines as string[]) ?? [],
    tags: (s.tags as string[]) ?? [],
    lat: geocode?.lat ?? null,
    lng: geocode?.lon ?? null,
    budgetDinnerAvg: s.budget_dinner_avg != null ? Number(s.budget_dinner_avg) : null,
    availableDates: (s.availability as string[]) ?? [],
  };
}

type Calendar = { availability_calendar?: { data?: Record<string, Record<string, boolean>> } };

/**
 * Interpret an availability calendar for a slot. Keys are UTC instants;
 * alternatives are free times within 90 minutes of the requested one.
 */
export function readCalendar(cal: Calendar, slot: Slot): AvailabilityResult {
  const day = cal.availability_calendar?.data?.[slot.date];
  if (!day) return { status: "unknown", detail: "no calendar for that date" };
  const want = jst(slot.date, slot.time);
  let exact: boolean | undefined;
  const alternatives: string[] = [];
  for (const [iso, free] of Object.entries(day)) {
    const t = DateTime.fromISO(iso, { zone: "utc" }).setZone(ZONE);
    if (t.toMillis() === want.toMillis()) exact = free;
    else if (free && Math.abs(t.diff(want, "minutes").minutes) <= 90) alternatives.push(t.toFormat("HH:mm"));
  }
  if (exact === undefined) return { status: alternatives.length ? "unavailable" : "unknown", alternatives, detail: "requested time is not a bookable slot" };
  return { status: exact ? "available" : "unavailable", alternatives };
}

/**
 * TableCheck takes guest bookings (name, phone, email) and emails a manage
 * link, so an account is optional. Without credentials we book as a guest.
 */
async function ensureLoggedIn(page: Page): Promise<void> {
  const { email, password } = config.booking.tablecheck;
  if (!email || !password) return;
  await page.goto("https://www.tablecheck.com/en/login");
  if (!page.url().includes("login")) return; // already signed in
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: /log ?in|sign ?in/i }).click();
  await page.waitForLoadState("networkidle");
}

export const tablecheck: BookingAdapter = {
  channel: "tablecheck",

  async checkAvailability(place: Place, slot: Slot): Promise<AvailabilityResult> {
    if (!place.tablecheck_slug) return { status: "unknown", detail: "no TableCheck slug" };
    try {
      const cal = (await getJson(`${API}/hub/availability_calendar`, {
        method: "POST",
        body: JSON.stringify({ locale: "en", start_at: slot.date, shop_id: place.tablecheck_slug, num_people: String(slot.partySize) }),
      })) as Calendar;
      return readCalendar(cal, slot);
    } catch (err) {
      return { status: "unknown", detail: (err as Error).message };
    }
  },

  async book(place: Place, slot: Slot, contact: Contact, notes?: string): Promise<BookResult> {
    if (!place.tablecheck_slug) return { status: "failed", detail: "no TableCheck slug" };
    return withPage("tablecheck", async (page) => {
      await ensureLoggedIn(page);
      const q = new URLSearchParams({ num_people: String(slot.partySize), date: slot.date, time: slot.time });
      await page.goto(`https://www.tablecheck.com/en/shops/${place.tablecheck_slug}/reserve?${q}`);

      // Party size, date and time are prefilled from the query; pick the time explicitly in case they aren't.
      const timeBtn = page.getByRole("button", { name: new RegExp(`^\\s*${slot.time}`) }).first();
      if (await timeBtn.isVisible().catch(() => false)) await timeBtn.click();
      await page.getByRole("button", { name: /next|continue|proceed|details/i }).first().click();

      // Guest details (prefilled for logged-in users; fill anything left empty).
      for (const [label, value] of [
        [/first name/i, contact.name.split(" ")[0]],
        [/last name/i, contact.name.split(" ").slice(1).join(" ") || contact.name],
        [/phone/i, intlPhone(contact.phone)],
        [/email/i, contact.email],
      ] as const) {
        const field = page.getByLabel(label).first();
        if ((await field.isVisible().catch(() => false)) && !(await field.inputValue().catch(() => ""))) await field.fill(value);
      }
      if (notes) {
        const req = page.getByLabel(/request|message|note/i).first();
        if (await req.isVisible().catch(() => false)) await req.fill(notes);
      }
      for (const box of await page.getByRole("checkbox").all()) if (!(await box.isChecked())) await box.check().catch(() => {});

      const policyText = (await page.getByText(/cancel/i).allInnerTexts().catch(() => [])).join("\n").slice(0, 2000);

      if (config.dryRun) return { status: "requested", policyText, detail: "DRY_RUN: stopped before the final confirm" };

      await page.getByRole("button", { name: /confirm|reserve|book|submit/i }).last().click();
      await page.waitForLoadState("networkidle");
      const body = await page.locator("body").innerText();
      if (!/confirmed|thank you|complete|予約が完了/i.test(body)) {
        return { status: "failed", policyText, detail: "no confirmation shown after submitting" };
      }
      const ref = body.match(/(?:reservation|booking|予約)\s*(?:no\.?|number|ref|番号)[:\s#]*([A-Z0-9-]{5,})/i)?.[1];
      return { status: "confirmed", externalRef: ref, manageUrl: page.url(), policyText };
    });
  },

  async modify(reservation: Reservation, place: Place, slot: Slot, contact: Contact): Promise<ChangeResult> {
    // TableCheck changes are cancel + rebook unless the manage page offers "change";
    // rebook first so the date never ends up with no table.
    const fresh = await this.book(place, slot, contact);
    if (fresh.status !== "confirmed") return { ok: false, detail: `couldn't book the new time: ${fresh.detail ?? fresh.status}` };
    const cancelled = await this.cancel(reservation, place, contact);
    return { ok: cancelled.ok, detail: cancelled.ok ? fresh.externalRef : `new booking made but old one not cancelled: ${cancelled.detail}` };
  },

  async cancel(reservation: Reservation): Promise<ChangeResult> {
    if (!reservation.manage_url) return { ok: false, detail: "no manage link stored for this booking" };
    return withPage("tablecheck", async (page) => {
      await ensureLoggedIn(page);
      await page.goto(reservation.manage_url!);
      await page.getByRole("button", { name: /cancel/i }).first().click();
      if (config.dryRun) return { ok: true, detail: "DRY_RUN: stopped before confirming the cancellation" };
      page.once("dialog", (d) => d.accept());
      const confirm = page.getByRole("button", { name: /yes|confirm|cancel reservation/i }).last();
      if (await confirm.isVisible().catch(() => false)) await confirm.click();
      await page.waitForLoadState("networkidle");
      const body = await page.locator("body").innerText();
      return /cancelled|canceled|キャンセル(済|しました)/i.test(body) ? { ok: true } : { ok: false, detail: "no cancellation confirmation shown" };
    });
  },
};

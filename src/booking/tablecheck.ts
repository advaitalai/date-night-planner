import { DateTime } from "luxon";
import type { Page } from "playwright-core";
import { config, domesticPhone, type Contact } from "../config";
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

/** Menu items the bot will pick: seat-only reservations without prepayment. Never courses. */
export function isSeatOnly(name: string): boolean {
  return /seats? only|table only|席のみ|お席のみ|座席のみ/i.test(name);
}

const TIME_12H = (t: string) => DateTime.fromFormat(t, "HH:mm").toFormat("h:mm a");

/**
 * TableCheck's classic single-page form (/en/shops/<slug>/reserve):
 * availability grid → seat-only menu item → additional info → guest details →
 * "Next Step" → confirmation page → "Confirm". DRY_RUN stops on the
 * confirmation page, after TableCheck has validated everything.
 */
async function bookClassic(page: Page, slot: Slot, contact: Contact, notes?: string): Promise<BookResult> {
  await page.waitForTimeout(1500);

  // 1. Click the slot in the availability grid: day column (by x position, since closed days span rows) × time row.
  const day = Number(slot.date.slice(8));
  const header = page.locator("#timetable-body td.wday").filter({ has: page.locator(".date-num", { hasText: new RegExp(`^${day}$`) }) }).first();
  const hb = await header.boundingBox();
  if (!hb) return { status: "failed", detail: `the availability grid doesn't show ${slot.date}` };
  const row = page.locator("tr.timetable-row").filter({ has: page.locator("th.time-left", { hasText: new RegExp(`^\\s*${TIME_12H(slot.time)}\\s*$`) }) });
  const cells = row.locator("td");
  let picked = false;
  for (let i = 0; i < (await cells.count()); i++) {
    const bb = await cells.nth(i).boundingBox();
    if (!bb || Math.abs(bb.x + bb.width / 2 - (hb.x + hb.width / 2)) > 5) continue;
    if (!/available/.test((await cells.nth(i).getAttribute("class")) ?? "")) return { status: "failed", detail: `${slot.time} on ${slot.date} is not available` };
    await cells.nth(i).locator("a").click();
    picked = true;
    break;
  }
  if (!picked) return { status: "failed", detail: `no ${slot.time} slot in the grid` };
  await page.waitForTimeout(2000);
  await page.locator("#reservation_num_people_adult").selectOption(String(slot.partySize));
  await page.waitForTimeout(1000);

  // 2. Menu: seat-only, no prepayment. Shops without a menu list are seat-only by default.
  const items = page.locator(".menu-item:has(.menu-item-data)");
  if (await items.count()) {
    let chose = "";
    for (let i = 0; i < (await items.count()); i++) {
      const data = items.nth(i).locator(".menu-item-data").first();
      const name = (await data.getAttribute("data-name")) ?? "";
      const pay = (await data.getAttribute("data-payment-type")) ?? "none";
      if (!isSeatOnly(name) || pay !== "none" || !(await items.nth(i).isVisible())) continue;
      // Seat-only items are tied to seating categories (e.g. Tables/Counters, not Partition);
      // the slot must be free in that category, so select it explicitly.
      const categories = JSON.parse((await data.getAttribute("data-service-categories")) ?? "[]") as string[];
      if (categories.length) {
        const radio = page.locator(`input[name='reservation[service_category]'][value='${categories[0]}']`);
        // The radio sits inside a Bootstrap toggle button; click the wrapper.
        if ((await radio.count()) && !(await radio.isChecked())) {
          await radio.locator("xpath=..").click();
          await page.waitForTimeout(1500);
        }
      }
      await items.nth(i).locator("label.menu-item-order-btn").first().click();
      chose = name;
      break;
    }
    if (!chose) return { status: "failed", detail: "no seat-only option without prepayment (courses only, or a card is required)" };
  }

  // 3. Additional information.
  const purpose = page.locator("#reservation_objective");
  if (await purpose.count()) await purpose.selectOption("date").catch(() => {});
  for (const q of await page.locator("textarea[name*='enquete_drafts_attributes']").all()) if (await q.isVisible()) await q.fill("None");
  if (notes) await page.locator("#reservation_customer_request").fill(notes).catch(() => {});

  // 4. Guest details. Phone in Japanese domestic format (the field defaults to Japan).
  const [first, ...rest] = contact.name.split(" ");
  await page.locator("#reservation_customer_first_name").fill(first);
  await page.locator("#reservation_customer_last_name").fill(rest.join(" ") || first);
  await page.locator("#reservation_customer_phone").fill(domesticPhone(contact.phone));
  await page.locator("#reservation_customer_email").fill(contact.email);
  await page.locator("#reservation_customer_preferred_text_provider_none").check({ force: true }).catch(() => {});
  for (const id of ["#reservation_confirm_shop_note", "#reservation_confirm_shop_note2"]) {
    const box = page.locator(id);
    if ((await box.count()) && !(await box.isChecked())) await box.check({ force: true }).catch(() => {});
  }
  const venueMessage = ((await page.locator("body").innerText()).match(/Message from Venue([\s\S]*?)I confirm I've read/i)?.[1] ?? "").trim().slice(0, 1500);

  // 5. Next Step → TableCheck validates and shows the confirmation page.
  await page.locator("input[type=submit][value='Next Step']").first().click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(2000);
  const confirmBtn = page.locator("input[type=submit][value='Confirm']");
  if (!(await confirmBtn.isVisible().catch(() => false))) {
    const errors = (await page.locator(".has-error, .alert-danger, .error, .help-block").allInnerTexts().catch(() => [])).join(" / ");
    return { status: "failed", detail: `TableCheck didn't accept the form${errors ? `: ${errors.slice(0, 300)}` : ""}` };
  }
  const summary = (await page.locator("body").innerText()).replace(/\n{2,}/g, "\n");
  // The confirmation page has a "Cancellation Policy" section; keep the venue message for context.
  const policySection = summary.match(/Cancellation Policy[\s\S]{0,800}/i)?.[0] ?? "";
  const policyText = [policySection, venueMessage].filter(Boolean).join("\n\n").slice(0, 2500);

  if (config.dryRun) return { status: "requested", policyText, detail: `DRY_RUN: stopped on the confirmation page.\n${summary.slice(0, 1500)}` };

  // 6. Confirm for real.
  await confirmBtn.click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(2000);
  const body = await page.locator("body").innerText();
  if (!/confirmed|thank you|complete|reservation (number|no)|予約が(完了|確定)/i.test(body)) {
    return { status: "failed", policyText, detail: `no confirmation shown after submitting: ${body.slice(0, 300)}` };
  }
  const ref = body.match(/(?:reservation|booking|予約)\s*(?:no\.?|number|ref|code|番号)[:\s#]*([A-Z0-9-]{5,})/i)?.[1];
  return { status: "confirmed", externalRef: ref, manageUrl: page.url(), policyText, detail: body.slice(0, 800) };
}

export const tablecheck: BookingAdapter = {
  channel: "tablecheck",

  async checkAvailability(place: Place, slot: Slot): Promise<AvailabilityResult> {
    if (!place.tablecheck_slug) return { status: "unknown", detail: "no TableCheck slug" };
    try {
      const cal = (await getJson(`${API}/hub/availability_calendar`, {
        method: "POST",
        // The calendar returns a window of ~9 slots around start_at, so send the requested time, not just the date.
        body: JSON.stringify({ locale: "en", start_at: jst(slot.date, slot.time).toISO(), shop_id: place.tablecheck_slug, num_people: String(slot.partySize) }),
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
      await page.goto(`https://www.tablecheck.com/en/shops/${place.tablecheck_slug}/reserve?${q}`, { waitUntil: "networkidle" });
      // Shops on TableCheck's newer step-by-step flow redirect to /<slug>/reserve/message.
      if (!page.url().includes("/shops/")) {
        return { status: "failed", detail: "this restaurant uses TableCheck's newer booking flow, which the bot can't complete yet" };
      }
      return bookClassic(page, slot, contact, notes);
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

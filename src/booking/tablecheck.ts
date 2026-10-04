import { DateTime } from "luxon";
import type { Page } from "playwright-core";
import { config, domesticPhone, type Contact } from "../config";
import { getPrefs } from "../db/repo";
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

/**
 * TableCheck's nginx answers bursts of parallel requests with 403/429, so
 * calls are queued one at a time with a short gap and retried with backoff.
 */
const MIN_GAP_MS = 500;
let queue: Promise<unknown> = Promise.resolve();

function paced<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {}).then(() => new Promise((r) => setTimeout(r, MIN_GAP_MS)));
  return run;
}

async function getJson(url: string, init?: RequestInit, retries = 4): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const res = await paced(() => fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(15_000) }));
    if (res.ok) return res.json();
    if ((res.status === 403 || res.status === 429) && attempt < retries) {
      await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
      continue;
    }
    throw new Error(`TableCheck ${res.status} for ${url}`);
  }
}

/** Text search for shop slugs by name. */
export async function tcAutocomplete(text: string): Promise<{ slug: string; name: string; names: string[] }[]> {
  const q = new URLSearchParams({ shop_universe_id: SHOP_UNIVERSE_ID, locale: "en", text });
  const data = (await getJson(`${API}/autocomplete?${q}`)) as { shops?: AutocompleteShop[] };
  return (data.shops ?? []).filter((s) => s.payload?.shop_slug).map((s) => ({ slug: s.payload!.shop_slug!, ...autocompleteNames(s) }));
}

type AutocompleteShop = { text?: string; text_translations?: { locale: string; translation: string | null }[]; payload?: { shop_slug?: string } };

/** Shop names come as `text_translations` (older responses had a plain `text`): English name first, plus every translation for matching. */
export function autocompleteNames(s: AutocompleteShop): { name: string; names: string[] } {
  const t = s.text_translations ?? [];
  const names = [...new Set([...t.map((x) => x.translation), s.text].filter((x): x is string => !!x))];
  return { name: t.find((x) => x.locale === "en")?.translation ?? names[0] ?? s.payload?.shop_slug ?? "", names };
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

const NEXT_STEP = 'input[type=submit][value="Next Step"]';

/**
 * Fill TableCheck's one-page reserve form. The query string doesn't reliably
 * preset date/time, and venues add required fields (seating category, menu,
 * purpose, questions), so each is set from the form's Rails field names.
 * Returns null when "Next Step" is enabled, else what's still missing.
 *
 * Only the venue-note confirmation boxes are ticked: "create account" would
 * add required password fields and "receive offers" is marketing.
 * A menu item is chosen only if it's a seats-only option; priced courses are
 * left for the couple to pick.
 */
export async function fillReserveForm(page: Page, slot: Slot, contact: Contact, notes?: string): Promise<string | null> {
  const people = page.locator('select[name="reservation[num_people_adult]"]');
  if ((await people.isVisible().catch(() => false)) && (await people.inputValue()) !== String(slot.partySize)) {
    await people.selectOption(String(slot.partySize));
    await page.waitForLoadState("networkidle");
  }

  // Date: Mobiscroll calendar; day cells carry data-full="YYYY-(month-1)-D".
  const [y, m, d] = slot.date.split("-").map(Number);
  await page.locator('input[name="reservation[start_date]"]').click();
  const day = page.locator(`.dw-cal-day[data-full="${y}-${m - 1}-${d}"]:not(.dw-cal-day-diff):visible`).first();
  for (let i = 0; i < 3 && !(await day.isVisible().catch(() => false)); i++) {
    await page.locator(".dw-cal-next:visible, .dw-cal-btn-next:visible, [aria-label='Next month']:visible").first().click().catch(() => {});
    await page.waitForTimeout(300);
  }
  if (!(await day.isVisible().catch(() => false))) return `${slot.date} isn't bookable on TableCheck`;
  await day.click();
  await page.waitForLoadState("networkidle");

  // Time: options are epoch seconds.
  const epoch = String(jst(slot.date, slot.time).toSeconds());
  const time = page.locator('select[name="reservation[start_at_epoch]"]');
  await page.waitForFunction((e) => !!document.querySelector(`select[name="reservation[start_at_epoch]"] option[value="${e}"]`), epoch, { timeout: 10_000 }).catch(() => {});
  const times = await time.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
  if (!times.includes(epoch)) return `${slot.time} isn't offered on ${slot.date}`;
  await time.selectOption(epoch);
  // Changing date/time/category reloads menus and availability over XHR; let each settle.
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1000);

  const category = page.locator('input[type=radio][name="reservation[service_category]"]');
  if ((await category.count()) && !(await category.evaluateAll((rs) => rs.some((r) => (r as HTMLInputElement).checked)))) {
    await category.first().locator("xpath=..").click(); // the radio is wrapped in a styled label
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);
  }

  const purpose = page.locator('select[name="reservation[objective]"]');
  if (await purpose.isVisible().catch(() => false)) {
    const values = await purpose.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    const pick = ["date", "other"].find((v) => values.includes(v));
    if (pick) await purpose.selectOption(pick);
  }
  for (const box of await page.locator('textarea[name^="reservation[enquete_drafts_attributes]"]:visible').all()) {
    if (!(await box.inputValue())) await box.fill(getPrefs().dietary || "None");
  }
  if (notes) await page.locator('textarea[name="reservation[customer_request]"]:visible').first().fill(notes).catch(() => {});

  for (const [name, value] of [
    ["first_name", contact.name.split(" ")[0]],
    ["last_name", contact.name.split(" ").slice(1).join(" ") || contact.name],
    ["phone", domesticPhone(contact.phone)],
    ["email", contact.email],
  ] as const) {
    // :visible + first(): the phone widget keeps a hidden input with the same name.
    const field = page.locator(`input[name="reservation[customer][${name}]"]:visible`).first();
    if ((await field.isVisible().catch(() => false)) && !(await field.inputValue())) await field.fill(value);
  }
  for (const box of await page.locator('input[type=checkbox][name="reservation_confirm_shop_note"]:visible').all()) await box.check();

  const empty = await page.locator("input[required]:visible").evaluateAll((es) => es.filter((e) => !(e as HTMLInputElement).value).map((e) => (e as HTMLInputElement).name));
  if (empty.length) return `booking contact details missing: ${empty.join(", ")} (set BOOKING_NAME/PHONE/EMAIL)`;

  if (await page.locator(NEXT_STEP).isEnabled()) return null;

  // Still blocked: probably a menu choice is required.
  const menu = await page.locator(".menu-item-order-btn:visible").all();
  for (const btn of menu) {
    const text = await btn.evaluate((e) => e.closest(".row")?.textContent ?? "");
    if (/seats? only|table only|席のみ|お席のみ/i.test(text)) {
      await btn.click();
      await page.waitForLoadState("networkidle");
      break;
    }
  }
  if (await page.locator(NEXT_STEP).isEnabled()) return null;
  if (menu.length) {
    const courses = await Promise.all(menu.map((b) => b.evaluate((e) => (e.closest(".row")?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60))));
    return `this venue needs a course chosen when booking: ${courses.join(" / ")}`;
  }
  return "TableCheck's Next Step stayed disabled (a required field the bot doesn't know how to fill)";
}

async function readConfirmation(page: Page, policyText: string): Promise<BookResult> {
  const body = await page.locator("body").innerText();
  if (!/confirmed|thank you|complete|予約が完了/i.test(body)) {
    return { status: "failed", policyText, detail: "no confirmation shown after submitting" };
  }
  const ref = body.match(/(?:reservation|booking|予約)\s*(?:no\.?|number|ref|番号)[:\s#]*([A-Z0-9-]{5,})/i)?.[1];
  return { status: "confirmed", externalRef: ref, manageUrl: page.url(), policyText };
}

/**
 * The newer TableCheck booking app: venue message → landing (party, date,
 * time, seating) → menu → review. Same rules as the one-page form: seats-only
 * menu items only, tick only the cancellation-policy box, no account or
 * marketing opt-in. Its "Confirm booking" button is enabled even with empty
 * fields, so required fields are checked here before stopping (DRY_RUN) or
 * confirming.
 */
async function bookStepFlow(page: Page, slot: Slot, contact: Contact, notes?: string): Promise<BookResult> {
  const id = (testId: string) => page.getByTestId(testId);
  const panelOpen = () => id("Bottom Panel Title").isVisible().catch(() => false);

  if (page.url().includes("/reserve/message")) await id("Footer Button").first().click();
  await id("Landing Find A Table Button").waitFor();

  const pax = (await id("Landing Pax Panel Opener Button").innerText().catch(() => "")).trim();
  if (pax && !pax.startsWith(`${slot.partySize} `)) return { status: "failed", detail: `party size shows "${pax}", expected ${slot.partySize}` };

  // Date: month tables are labelled "YYYY-MM"; days outside the month have no text.
  const start = jst(slot.date, slot.time);
  await id("Landing Date Panel Opener Button").click();
  const month = page.locator(`table[aria-label="${start.toFormat("yyyy-MM")}"]`);
  await page.locator("table[aria-label]").first().waitFor();
  for (let i = 0; i < 3 && !(await month.isVisible().catch(() => false)); i++) {
    await id("Calendar Next Month Button").click();
    await page.waitForTimeout(500);
  }
  const day = month.locator("button[data-testid=day]:not([disabled])", { hasText: new RegExp(`^${start.day}$`) });
  if (!(await day.isVisible().catch(() => false))) return { status: "failed", detail: `${slot.date} isn't bookable on TableCheck` };
  await day.click();

  const label = start.setLocale("en").toFormat("h:mm a"); // "6:30 PM"
  if ((await id("Landing Time Panel Opener Button").innerText()).trim() !== label) {
    if (!(await panelOpen())) await id("Landing Time Panel Opener Button").click();
    await id("Landing Time Button").first().waitFor();
    const time = id("Landing Time Button").filter({ hasText: new RegExp(`^${label}$`) });
    if (!(await time.count())) return { status: "failed", detail: `${slot.time} isn't offered on ${slot.date}` };
    await time.first().click();
  }

  const category = id("Landing Service Category Panel Opener Button");
  if ((await category.isVisible().catch(() => false)) && /select/i.test(await category.innerText())) {
    if (!(await panelOpen())) await category.click();
    await id("Landing Service Category Button").first().click();
  }

  await id("Landing Find A Table Button").click();
  await page.waitForURL(/\/reserve\/(menu|review)/, { timeout: 20_000 }).catch(() => {});
  if (!/\/reserve\/(menu|review)/.test(page.url())) {
    const shown = (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 200);
    return { status: "failed", detail: `TableCheck didn't offer ${slot.time}: ${shown}` };
  }

  if (page.url().includes("/reserve/menu")) {
    const items = id("Menu Item");
    const seatOnly = items.filter({ has: id("Menu Item Title").filter({ hasText: /seats? only|table only|席のみ/i }) }).first();
    if (await seatOnly.isVisible().catch(() => false)) {
      await seatOnly.click();
      await id("Menu Item Modal Add Item").click();
    } else if (await items.count()) {
      const courses = (await id("Menu Item").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim().slice(0, 50));
      return { status: "failed", detail: `this venue needs a course chosen when booking: ${courses.join(" / ")}` };
    }
    await id("Footer Button").first().click();
    await page.waitForURL(/\/reserve\/review/, { timeout: 20_000 });
  }

  // Review page: the table is held for a few minutes.
  await id("Booking Review Page").waitFor();
  for (const [testId, value] of [
    ["Guest Form First Name Input", contact.name.split(" ")[0]],
    ["Guest Form Last Name Input", contact.name.split(" ").slice(1).join(" ") || contact.name],
    ["Guest Form Email Input", contact.email],
    ["Guest Form Confirm Phone Input", domesticPhone(contact.phone)],
  ] as const) {
    const field = id(testId);
    if ((await field.isVisible().catch(() => false)) && !(await field.inputValue())) await field.fill(value);
  }
  const required = id("Shop Enquetes Textarea Container").filter({ has: id("Shop Enquetes Textarea Title").filter({ hasText: /REQ/ }) }).locator("textarea");
  for (const box of await required.all()) if (!(await box.inputValue())) await box.fill(getPrefs().dietary || "None");
  if (notes) await id("Customer Request").fill(notes).catch(() => {});
  const affirm = id("Cancel Policy Affirmation Checkbox");
  if (await affirm.isVisible().catch(() => false)) await affirm.check();

  const missing: string[] = [];
  for (const testId of ["Guest Form First Name Input", "Guest Form Last Name Input", "Guest Form Email Input", "Guest Form Confirm Phone Input"]) {
    const field = id(testId);
    if ((await field.isVisible().catch(() => false)) && !(await field.inputValue())) missing.push(testId.replace(/^Guest Form | Input$/g, ""));
  }
  if (missing.length) return { status: "failed", detail: `booking contact details missing: ${missing.join(", ")} (set BOOKING_NAME/PHONE/EMAIL)` };

  const policyText = (await id("Cancel Policy Message").innerText().catch(() => "")).slice(0, 2000);
  if (config.dryRun) return { status: "requested", policyText, detail: "DRY_RUN: reached TableCheck's review page and stopped before Confirm booking" };

  await id("Footer Button").filter({ hasText: /confirm/i }).first().click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(2000);
  return readConfirmation(page, policyText);
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
        // start_at needs the time: the calendar covers about ±2h around it (a bare date gives 00:00–04:00).
        body: JSON.stringify({ locale: "en", start_at: jst(slot.date, slot.time).toUTC().toISO(), shop_id: place.tablecheck_slug, num_people: String(slot.partySize) }),
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

      await page.waitForLoadState("networkidle");
      // Venues are on one of two TableCheck UIs: the newer step-by-step app (data-testid
      // attributes, /reserve/message → landing → menu → review) or the older one-page form.
      if (/\/reserve\/(message|landing|menu|review)/.test(page.url())) return bookStepFlow(page, slot, contact, notes);

      const problem = await fillReserveForm(page, slot, contact, notes);
      if (problem) return { status: "failed", detail: problem };

      // "Next Step" leads to a review page that holds the table for ~10 minutes; "Confirm" there books it.
      await page.locator(NEXT_STEP).click();
      await page.waitForURL(/\/review/, { timeout: 20_000 }).catch(() => {});
      if (!/\/review/.test(page.url())) {
        const errors = (await page.locator(".alert:not(.alert-info):visible").allInnerTexts().catch(() => [])).map((t) => t.replace(/^×\s*/, "").trim()).filter(Boolean);
        return { status: "failed", detail: `TableCheck didn't accept the form${errors.length ? `: ${errors.join("; ").slice(0, 300)}` : ""}` };
      }
      const policyText = (await page.getByText(/cancel|キャンセル/i).allInnerTexts().catch(() => [])).join("\n").slice(0, 2000);

      if (config.dryRun) return { status: "requested", policyText, detail: "DRY_RUN: reached TableCheck's review page and stopped before Confirm" };

      await page.locator('input[type=submit][value="Confirm"], button:has-text("Confirm")').first().click();
      await page.waitForLoadState("networkidle");
      return readConfirmation(page, policyText);
    });
  },

  async modify(reservation: Reservation, place: Place, slot: Slot, contact: Contact): Promise<ChangeResult> {
    // TableCheck changes are cancel + rebook unless the manage page offers "change";
    // rebook first so the date never ends up with no table.
    const fresh = await this.book(place, slot, contact);
    if (fresh.status !== "confirmed" && !(config.dryRun && fresh.status === "requested")) return { ok: false, detail: `couldn't book the new time: ${fresh.detail ?? fresh.status}` };
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

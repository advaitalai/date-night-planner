import path from "node:path";
import { DateTime } from "luxon";
import type { Page } from "playwright-core";
import { config, domesticPhone, type Contact } from "../config";
import { kvGet, kvSet } from "../db";
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

/** Pause after a 403: TableCheck refuses bursts of requests for a few seconds. */
const backoff = (attempt: number) => new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
    if (res.status !== 403 || attempt === 2) break;
    await backoff(attempt);
  }
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

export interface TcShopInfo {
  /** "classic" = /en/shops/<slug>/reserve single-page form; "new" = step-by-step flow. */
  flow: "classic" | "new";
  /** Has a seat-only menu item without prepayment (or no menu at all). null = unknown. */
  seatOnly: boolean | null;
}

/**
 * Seat-only, prepayment-free check on the classic form's server-rendered menu.
 * null when the page isn't the booking form at all (an error or bot-check page).
 */
export function parseClassicMenu(html: string): boolean | null {
  if (!/id="new_reservation"|reservation_num_people_adult/.test(html)) return null;
  const items = [...html.matchAll(/<div class="menu-item-data"([^>]*)>/g)].map((m) => ({
    name: m[1].match(/data-name="([^"]*)"/)?.[1] ?? "",
    pay: m[1].match(/data-payment-type="([^"]*)"/)?.[1] ?? "none",
  }));
  return items.length === 0 || items.some((i) => isSeatOnly(i.name) && i.pay === "none");
}

/** Which booking flow a shop uses and whether it offers seat-only. Cached for a week (tcinfo3: since the 12 Oct seat-only and 403 fixes). */
export async function tcShopInfo(slug: string): Promise<TcShopInfo> {
  const cached = kvGet<(TcShopInfo & { at: string }) | null>(`tcinfo3:${slug}`, null);
  if (cached && Date.now() - Date.parse(cached.at) < 7 * 86_400_000) return cached;
  let res: Response;
  // Retry a 403 a little later, and never cache an error.
  for (let attempt = 0; ; attempt++) {
    res = await fetch(`https://www.tablecheck.com/en/shops/${slug}/reserve`, { redirect: "manual", headers: { "User-Agent": "Mozilla/5.0" } });
    if (res.status !== 403 || attempt === 2) break;
    await backoff(attempt);
  }
  if (res.status >= 400) throw new Error(`TableCheck shop page ${res.status}`);
  const info: TcShopInfo = res.status >= 300 ? { flow: "new", seatOnly: null } : { flow: "classic", seatOnly: parseClassicMenu(await res.text()) };
  if (info.seatOnly === null && info.flow === "classic") throw new Error("TableCheck shop page wasn't the booking form");
  kvSet(`tcinfo3:${slug}`, { ...info, at: new Date().toISOString() });
  return info;
}

/** TableCheck's post-submit page, e.g. "Your Reservation is Accepted … Status Accepted". */
/**
 * TableCheck's review page: everything was accepted and the table is held for
 * 10 minutes, waiting for the final Confirm. Where a dry run stops.
 */
export function isReviewPage(body: string): boolean {
  return /time remaining to confirm|reservation is not yet booked/i.test(body);
}

export function isBookedPage(body: string): boolean {
  return /reservation is (accepted|confirmed)|status\s+(accepted|confirmed)|confirmed|thank you|complete|予約が(完了|確定)|予約を受け付け/i.test(body);
}

/**
 * Menu items the bot will pick: a plain table or seat booking for dinner
 * ("Seats only", "Book a Table", "Dining Table", "Bar Counter", "席のみ").
 * Never courses, set menus, drink packages, lunch/café-only or takeout items.
 * (Prepayment is checked separately, on the item's payment type.)
 */
export function isSeatOnly(name: string): boolean {
  if (/course|コース|omakase|おまかせ|plan\b|プラン|\bset\b|セット|package|飲み放題|nomi ?hodai|lunch|ランチ|breakfast|モーニング|caf[eé]|dessert|デザート|take ?out|テイクアウト|pick ?up/i.test(name)) return false;
  return /seat|table|counter|席/i.test(name);
}

const TIME_12H = (t: string) => DateTime.fromFormat(t, "HH:mm").toFormat("h:mm a");

async function selectSeatOnlyCategory(page: Page): Promise<void> {
  const data = page.locator(".menu-item-data");
  for (let i = 0; i < (await data.count()); i++) {
    const d = data.nth(i);
    if (!isSeatOnly((await d.getAttribute("data-name")) ?? "") || ((await d.getAttribute("data-payment-type")) ?? "none") !== "none") continue;
    const categories = JSON.parse((await d.getAttribute("data-service-categories")) ?? "[]") as string[];
    if (!categories.length) return;
    const radio = page.locator(`input[name='reservation[service_category]'][value='${categories[0]}']`);
    if ((await radio.count()) && !(await radio.isChecked())) {
      await radio.locator("xpath=..").click();
      await page.waitForTimeout(2000);
    }
    return;
  }
}

/** Free times (HH:mm) in the grid's column for one day, read from the page in one go. */
async function freeTimesInColumn(page: Page, columnX: number): Promise<string[]> {
  // No named functions inside evaluate (tsx would inject a helper the page doesn't have).
  const labels = await page
    .evaluate(
      (x) =>
        Array.from(document.querySelectorAll("tr.timetable-row"))
          .filter((row) =>
            Array.from(row.querySelectorAll("td")).some((td) => {
              const r = td.getBoundingClientRect();
              return Math.abs(r.left + r.width / 2 - x) <= 5 && /available/.test(td.className);
            }),
          )
          .map((row) => (row.querySelector("th.time-left")?.textContent ?? "").trim()),
      columnX,
    )
    .catch(() => [] as string[]);
  return labels
    .map((l) => DateTime.fromFormat(l.toUpperCase(), "h:mm a"))
    .filter((d) => d.isValid)
    .map((d) => d.toFormat("HH:mm"));
}

/** Step 1 on the grid layout: click the day column (by x position, since closed days span rows) × time row. */
async function pickFromGrid(page: Page, slot: Slot): Promise<BookResult | null> {
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
    if (!/available/.test((await cells.nth(i).getAttribute("class")) ?? "")) {
      const alternatives = await freeTimesInColumn(page, hb.x + hb.width / 2);
      return { status: "failed", full: true, alternatives, detail: `${slot.time} on ${slot.date} is full on TableCheck` };
    }
    await cells.nth(i).locator("a").click();
    picked = true;
    break;
  }
  if (!picked) return { status: "failed", detail: `no ${slot.time} slot in the grid` };
  await page.waitForTimeout(2000);
  await page.locator("#reservation_num_people_adult").selectOption(String(slot.partySize));
  await page.waitForTimeout(1000);
  return null;
}

/**
 * Step 1 on the dropdown layout (no grid; e.g. SMOKEHOUSE): party size, then the
 * date in the calendar pop-up (Mobiscroll; data-full has a 0-based month), then
 * the time. The time list only offers free times.
 */
async function pickFromDropdowns(page: Page, slot: Slot): Promise<BookResult | null> {
  await page.locator("#reservation_num_people_adult").selectOption(String(slot.partySize));
  await page.waitForTimeout(1000);
  await page.locator("#reservation_start_date").click();
  await page.waitForTimeout(800);
  const [y, m, d] = slot.date.split("-").map(Number);
  const day = page.locator(`[data-full='${y}-${m - 1}-${d}']`).first();
  for (let i = 0; i < 3 && !(await day.isVisible().catch(() => false)); i++) {
    await page.locator(".dw-cal-next, .dw-cal-next-m").first().click().catch(() => {});
    await page.waitForTimeout(500);
  }
  if (!(await day.isVisible().catch(() => false))) return { status: "failed", detail: `the date picker doesn't offer ${slot.date}` };
  // Closed or fully booked days can't be picked.
  if (!/dw-cal-day-v/.test((await day.getAttribute("class")) ?? "")) return { status: "failed", full: true, alternatives: [], detail: `${slot.date} is closed or full on TableCheck` };
  await day.click();
  await page.waitForTimeout(2000);
  const options = await page.locator("#reservation_start_at_epoch option").evaluateAll((os) =>
    os.filter((o) => (o as HTMLOptionElement).value && !(o as HTMLOptionElement).disabled).map((o) => ({ label: (o.textContent ?? "").trim(), value: (o as HTMLOptionElement).value })),
  );
  const times = options.map((o) => ({ ...o, time: DateTime.fromFormat(o.label.toUpperCase(), "h:mm a").toFormat("HH:mm") }));
  const want = times.find((t) => t.time === slot.time);
  if (!want) return { status: "failed", full: true, alternatives: times.map((t) => t.time).filter((t) => t !== "Invalid DateTime"), detail: `${slot.time} on ${slot.date} is full on TableCheck` };
  await page.locator("#reservation_start_at_epoch").selectOption(want.value);
  // The menu list reloads for the chosen time; let it settle before picking an item.
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(2000);
  return null;
}

/**
 * TableCheck's classic single-page form (/en/shops/<slug>/reserve):
 * availability grid (or date + time dropdowns) → seat-only menu item → additional info → guest details →
 * "Next Step" → confirmation page → "Confirm". DRY_RUN stops on the
 * confirmation page, after TableCheck has validated everything.
 */
async function bookClassic(page: Page, slot: Slot, contact: Contact, notes?: string): Promise<BookResult> {
  await page.waitForTimeout(1500);

  // 0. Seat-only items are tied to seating categories (e.g. Tables/Counters, not Partition).
  //    Pick that category first, so the grid shows times free for seats only. (TableCheck's
  //    availability API counts every category, which is why 18:30 could look free but be refused.)
  await selectSeatOnlyCategory(page);

  // 1. Pick the date and time: availability grid, or date + time dropdowns on some shops.
  const usesGrid = (await page.locator("#timetable-body td.wday").count()) > 0;
  const stop = usesGrid ? await pickFromGrid(page, slot) : await pickFromDropdowns(page, slot);
  if (stop) return stop;

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
      // A picked item has its checkbox ticked; a click during a menu refresh can be lost, so check and retry.
      const btn = items.nth(i).locator("label.menu-item-order-btn").first();
      const box = btn.locator("input[type=checkbox]");
      for (let attempt = 0; attempt < 3; attempt++) {
        await btn.click();
        await page.waitForTimeout(1000);
        if (!(await box.count()) || (await box.isChecked().catch(() => false))) {
          chose = name;
          break;
        }
      }
      if (!chose) return { status: "failed", detail: `couldn't select "${name}" on the booking page` };
      break;
    }
    if (!chose) return { status: "failed", detail: "no seat-only option without prepayment (courses only, or a card is required)" };
  }

  // 3. Additional information.
  const purpose = page.locator("#reservation_objective");
  if (await purpose.count()) await purpose.selectOption("date").catch(() => {});
  for (const q of await page.locator("textarea[name*='enquete_drafts_attributes']").all()) if (await q.isVisible()) await q.fill("None");
  // Required acknowledgements ("If you are with children aged 6 or younger, enter them separately"): two adults, so tick them.
  for (const box of await page.locator("input[type=checkbox][name*='enquete_drafts_attributes']").all()) {
    if (!(await box.isChecked().catch(() => true))) await box.check({ force: true }).catch(() => {});
  }
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
  // The button reads "Confirm" or "CONFIRM" depending on the venue's layout (SMOKEHOUSE: "CONFIRM").
  const confirmBtn = page.getByRole("button", { name: /^\s*confirm\s*$/i }).first();
  const reviewing = (await confirmBtn.isVisible().catch(() => false)) || isReviewPage(await page.locator("body").innerText().catch(() => ""));
  if (!reviewing) {
    const errors = (await page.locator(".has-error, .alert-danger, .error, .help-block").allInnerTexts().catch(() => [])).join(" / ");
    // TableCheck adds "selected time is unavailable" to other form errors too (a missing answer, an
    // invalid phone), so it only means full when nothing else is wrong.
    const full = /time is unavailable|fully booked|満席/i.test(errors) && !/required|invalid|is not valid|must be/i.test(errors);
    const shot = path.join(config.dataDir, "screens", `tablecheck-refused-${Date.now()}.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    console.log(`[tablecheck] form not accepted: ${JSON.stringify(errors.slice(0, 500)) || "(no error text)"} @ ${page.url()} (screenshot: ${shot})`);
    return { status: "failed", full, detail: full ? `${slot.time} is full on TableCheck` : `TableCheck didn't accept the form${errors ? `: ${errors.slice(0, 300)}` : ""}` };
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
  if (!isBookedPage(body)) {
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
      // Only recommend what the bot can actually book: classic form + seat-only without a card.
      const info = await tcShopInfo(place.tablecheck_slug);
      if (info.flow === "new") return { status: "unknown", blocker: "unsupported_flow", detail: "uses TableCheck's newer booking flow (not supported yet)" };
      if (info.seatOnly === false) return { status: "unknown", blocker: "courses_only", detail: "courses only, or seat-only needs a card" };
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

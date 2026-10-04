import type { Page } from "playwright-core";
import { config, domesticPhone, type Contact } from "../config";
import type { Place, Reservation } from "../types";
import { withPage } from "./browser";
import type { AvailabilityResult, BookingAdapter, BookResult, ChangeResult, Slot } from "./types";

/**
 * Tabelog.
 *
 * Tabelog has no booking API, so everything goes through the public site in a
 * headless browser logged into the Tabelog account. Restaurants with online
 * booking (ネット予約) show a "空席確認・予約する" button that opens a
 * calendar of free slots, then a booking form.
 *
 * Locators are text-based and need checking against the live site; any step
 * that can't be found returns "unknown"/"failed" rather than guessing.
 */

const RST_URL = /https:\/\/tabelog\.com\/[a-z]+\/A\d{4}\/A\d{6}\/\d+\/?/;

/** First restaurant URL in a Tabelog keyword search, plus whether it takes online bookings. */
export async function tabelogLookup(name: string, area = "東京"): Promise<{ url: string; netBooking: boolean; score: number | null } | null> {
  const q = new URLSearchParams({ sw: name, sa: area });
  const html = await fetchTabelog(`https://tabelog.com/rstLst/?${q}`);
  const url = html.match(RST_URL)?.[0];
  if (!url) return null;
  return { url: url.endsWith("/") ? url : url + "/", ...(await tabelogPageInfo(url)) };
}

export async function tabelogPageInfo(url: string): Promise<{ netBooking: boolean; score: number | null }> {
  return parseTabelogPage(await fetchTabelog(url));
}

/**
 * Fetch a Tabelog page. Throws when Tabelog refuses (e.g. a Cloudflare
 * "Just a moment..." 403 from datacenter IPs) so callers can say the check
 * didn't happen rather than treating it as "no online booking".
 */
async function fetchTabelog(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "ja" }, signal: AbortSignal.timeout(15_000) });
  const html = await res.text();
  if (!res.ok) throw new Error(`Tabelog ${res.status}${isBotChallenge(html) ? " (Cloudflare bot check)" : ""}`);
  return html;
}

export function isBotChallenge(html: string): boolean {
  return /<title>Just a moment\.\.\.<\/title>|challenges\.cloudflare\.com/.test(html);
}

export function parseTabelogPage(html: string): { netBooking: boolean; score: number | null } {
  const netBooking = /ネット予約可|空席確認・予約する|ネット予約/.test(html);
  const score = html.match(/rdheader-rating__score-val-dtl[^>]*>\s*([0-9]\.[0-9]{2})/)?.[1];
  return { netBooking, score: score ? Number(score) : null };
}

async function ensureLoggedIn(page: Page): Promise<void> {
  await page.goto("https://tabelog.com/");
  const loginLink = page.getByRole("link", { name: /ログイン/ }).first();
  if (!(await loginLink.isVisible().catch(() => false))) return;
  const { email, password } = config.booking.tabelog;
  if (!email || !password) throw new Error("TABELOG_EMAIL/TABELOG_PASSWORD not set");
  await loginLink.click();
  await page.getByLabel(/メールアドレス|email/i).first().fill(email);
  await page.getByLabel(/パスワード|password/i).first().fill(password);
  await page.getByRole("button", { name: /ログイン/ }).first().click();
  await page.waitForLoadState("networkidle");
}

/** Open the booking calendar and select the date/party size; returns the free times shown. */
async function openSlots(page: Page, place: Place, slot: Slot): Promise<string[] | null> {
  await page.goto(place.tabelog_url!);
  const reserve = page.getByRole("link", { name: /空席確認・予約する|予約する/ }).first();
  if (!(await reserve.isVisible().catch(() => false))) return null;
  await reserve.click();
  await page.waitForLoadState("networkidle");

  const people = page.getByLabel(/人数/).first();
  if (await people.isVisible().catch(() => false)) await people.selectOption({ value: String(slot.partySize) }).catch(() => {});
  const [, m, d] = slot.date.split("-").map(Number);
  const day = page.getByRole("button", { name: new RegExp(`^${d}$`) }).or(page.getByText(new RegExp(`${m}/${d}|${m}月${d}日`))).first();
  if (!(await day.isVisible().catch(() => false))) return null;
  await day.click();
  await page.waitForLoadState("networkidle");

  const times = await page.getByText(/^\d{1,2}:\d{2}$/).allInnerTexts();
  return times.map((t) => t.trim().padStart(5, "0"));
}

export const tabelog: BookingAdapter = {
  channel: "tabelog",

  async checkAvailability(place: Place, slot: Slot): Promise<AvailabilityResult> {
    if (!place.tabelog_url) return { status: "unknown", detail: "no Tabelog URL" };
    try {
      return await withPage("tabelog", async (page) => {
        const times = await openSlots(page, place, slot);
        if (!times) return { status: "unknown", detail: "couldn't open the booking calendar" };
        const alternatives = times.filter((t) => t !== slot.time);
        return { status: times.includes(slot.time) ? "available" : "unavailable", alternatives };
      });
    } catch (err) {
      return { status: "unknown", detail: (err as Error).message };
    }
  },

  async book(place: Place, slot: Slot, contact: Contact, notes?: string): Promise<BookResult> {
    if (!place.tabelog_url) return { status: "failed", detail: "no Tabelog URL" };
    return withPage("tabelog", async (page) => {
      await ensureLoggedIn(page);
      const times = await openSlots(page, place, slot);
      if (!times) return { status: "failed", detail: "couldn't open the booking calendar" };
      if (!times.includes(slot.time)) return { status: "failed", detail: `${slot.time} is no longer free (free: ${times.join(", ") || "none"})` };
      await page.getByText(new RegExp(`^${slot.time.replace(/^0/, "0?")}$`)).first().click();
      await page.getByRole("button", { name: /次へ|予約内容を確認|進む/ }).first().click();
      await page.waitForLoadState("networkidle");

      for (const [label, value] of [
        [/氏名|お名前/, contact.name],
        [/フリガナ|カナ/, contact.nameKana],
        [/電話/, domesticPhone(contact.phone)],
        [/メール/, contact.email],
      ] as const) {
        const field = page.getByLabel(label).first();
        if (value && (await field.isVisible().catch(() => false)) && !(await field.inputValue().catch(() => ""))) await field.fill(value);
      }
      if (notes) {
        const req = page.getByLabel(/要望|備考/).first();
        if (await req.isVisible().catch(() => false)) await req.fill(notes);
      }
      for (const box of await page.getByRole("checkbox").all()) if (!(await box.isChecked())) await box.check().catch(() => {});
      const policyText = (await page.getByText(/キャンセル/).allInnerTexts().catch(() => [])).join("\n").slice(0, 2000);

      if (config.dryRun) return { status: "requested", policyText, detail: "DRY_RUN: stopped before the final confirm" };

      await page.getByRole("button", { name: /予約を確定|確定する|予約する/ }).last().click();
      await page.waitForLoadState("networkidle");
      const body = await page.locator("body").innerText();
      if (!/予約が(確定|完了)|予約を受け付け|リクエスト/.test(body)) return { status: "failed", policyText, detail: "no confirmation shown after submitting" };
      // Some Tabelog restaurants take "request" bookings that the restaurant approves later.
      const status = /リクエスト/.test(body) && !/確定/.test(body) ? "requested" : "confirmed";
      const ref = body.match(/予約番号[:：\s]*([A-Z0-9-]{5,})/)?.[1];
      return { status, externalRef: ref, manageUrl: page.url(), policyText };
    });
  },

  async modify(reservation: Reservation, place: Place, slot: Slot, contact: Contact): Promise<ChangeResult> {
    const fresh = await this.book(place, slot, contact);
    if (fresh.status === "failed") return { ok: false, detail: `couldn't book the new time: ${fresh.detail}` };
    const cancelled = await this.cancel(reservation, place, contact);
    return { ok: cancelled.ok, detail: cancelled.ok ? fresh.externalRef : `new booking made but old one not cancelled: ${cancelled.detail}` };
  },

  async cancel(reservation: Reservation): Promise<ChangeResult> {
    return withPage("tabelog", async (page) => {
      await ensureLoggedIn(page);
      await page.goto(reservation.manage_url ?? "https://tabelog.com/booking/reservations/");
      if (!reservation.manage_url && reservation.external_ref) await page.getByText(reservation.external_ref).first().click();
      await page.getByRole("button", { name: /キャンセル/ }).or(page.getByRole("link", { name: /キャンセル/ })).first().click();
      if (config.dryRun) return { ok: true, detail: "DRY_RUN: stopped before confirming the cancellation" };
      page.once("dialog", (d) => d.accept());
      const confirm = page.getByRole("button", { name: /キャンセルする|はい|確定/ }).last();
      if (await confirm.isVisible().catch(() => false)) await confirm.click();
      await page.waitForLoadState("networkidle");
      const body = await page.locator("body").innerText();
      return /キャンセル(済|しました|が完了)/.test(body) ? { ok: true } : { ok: false, detail: "no cancellation confirmation shown" };
    });
  },
};

import type { BookingChannel, Place } from "../types";
import { tabelogLookup, tabelogPageInfo } from "./tabelog";
import { tcAutocomplete } from "./tablecheck";

/**
 * Work out how a place can be booked:
 *   1. Not a sit-down restaurant (spa, gallery, bakery…) → not_restaurant
 *   2. Booking links on its website (TableCheck / Tabelog / other widgets / mailto)
 *   3. TableCheck name search
 *   4. Tabelog keyword search (online booking badge)
 *   5. Otherwise phone if it has a number, walk-in if Google says it isn't reservable
 */

const NON_DINING_TYPES = new Set([
  "spa",
  "art_gallery",
  "museum",
  "bakery",
  "cafe",
  "coffee_shop",
  "dessert_shop",
  "confectionery",
  "ice_cream_shop",
  "tourist_attraction",
  "park",
  "store",
  "shopping_mall",
]);

const CASUAL_TYPES = new Set(["ramen_restaurant", "fast_food_restaurant", "hamburger_restaurant", "food_court"]);

export interface WebsiteLinks {
  tablecheckSlug?: string;
  tabelogUrl?: string;
  otherOnline?: string;
  email?: string;
}

/** Find booking links in a restaurant's own website HTML. */
export function scanWebsite(html: string): WebsiteLinks {
  const out: WebsiteLinks = {};
  // Prefer a dining page over takeout/delivery ones (e.g. "peterluger-pickup" listed before "peterluger").
  const slugs = [...html.matchAll(/tablecheck\.com\/(?:[a-z]{2}\/)?(?:shops\/)?([a-z0-9-]+)(?:\/reserve)?/gi)]
    .map((m) => m[1])
    .filter((slug) => !["en", "ja", "shops", "images", "assets"].includes(slug.toLowerCase()));
  const tc = slugs.find((slug) => !/-(pickup|takeout|take-out|delivery|gift)$/i.test(slug)) ?? slugs[0];
  if (tc) out.tablecheckSlug = tc;
  const tl = html.match(/https?:\/\/tabelog\.com\/[a-z]+\/A\d{4}\/A\d{6}\/\d+\/?/);
  if (tl) out.tabelogUrl = tl[0];
  const other = html.match(/https?:\/\/[^"'\s]*(?:ebica\.jp|toreta\.in|omakase\.in|yoyaku\.hotpepper\.jp|resty\.jp|ikyu\.com\/restaurant|autoreserve\.com)[^"'\s]*/i);
  if (other) out.otherOnline = other[0];
  const mail = html.match(/mailto:([^"'?\s]+@[^"'?\s]+)/i);
  if (mail) out.email = decodeURIComponent(mail[1]);
  return out;
}

export function isNonDining(p: Pick<Place, "primary_type" | "types">): boolean {
  if (p.primary_type && NON_DINING_TYPES.has(p.primary_type)) return true;
  return !p.types.some((t) => t.endsWith("restaurant") || t === "bar" || t === "meal_takeaway") && p.types.some((t) => NON_DINING_TYPES.has(t));
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9぀-ヿ一-鿿]/g, "");
}

/** Loose name match: one normalized name contains the other. */
export function sameName(a: string, b: string): boolean {
  const x = normalize(a);
  const y = normalize(b);
  return x.length > 2 && y.length > 2 && (x.includes(y) || y.includes(x));
}

export interface Detection {
  channel: BookingChannel;
  patch: Partial<Place>;
  evidence: string;
}

export async function detectChannel(place: Place): Promise<Detection> {
  if (isNonDining(place)) return { channel: "not_restaurant", patch: {}, evidence: `type ${place.primary_type}` };

  let links: WebsiteLinks = {};
  if (place.website) {
    try {
      const res = await fetch(place.website, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(10_000) });
      if (res.ok) links = scanWebsite(await res.text());
    } catch {
      // unreachable website: carry on with the platform searches
    }
    if (/tabelog\.com/.test(place.website)) links.tabelogUrl ??= place.website;
    if (/tablecheck\.com/.test(place.website)) links.tablecheckSlug ??= scanWebsite(place.website).tablecheckSlug;
  }

  if (links.tablecheckSlug) return { channel: "tablecheck", patch: { tablecheck_slug: links.tablecheckSlug }, evidence: "TableCheck link on website" };

  try {
    const hit = (await tcAutocomplete(place.name)).find((s) => s.names.some((n) => sameName(n, place.name)));
    if (hit) return { channel: "tablecheck", patch: { tablecheck_slug: hit.slug }, evidence: `TableCheck search: ${hit.name}` };
  } catch {
    // TableCheck unreachable; fall through
  }

  // Tabelog details (URL, score) are worth keeping even when it isn't the booking channel.
  let tabelogPatch: Partial<Place> = {};
  let tabelogNote = "";
  try {
    const tl = links.tabelogUrl ? { url: links.tabelogUrl, ...(await tabelogPageInfo(links.tabelogUrl)) } : await tabelogLookup(place.name);
    if (tl) {
      tabelogPatch = { tabelog_url: tl.url, tabelog_score: tl.score };
      if (tl.netBooking) return { channel: "tabelog", patch: tabelogPatch, evidence: "Tabelog online booking" };
    }
  } catch (err) {
    // Tabelog unreachable or blocked; fall through but say so, since the place may still be bookable there
    tabelogNote = ` (Tabelog not checked: ${(err as Error).message})`;
    if (links.tabelogUrl) tabelogPatch = { tabelog_url: links.tabelogUrl };
  }

  if (links.otherOnline) return { channel: "other_online", patch: { ...tabelogPatch, booking_url: links.otherOnline }, evidence: links.otherOnline + tabelogNote };
  if (links.email) return { channel: "email", patch: { ...tabelogPatch, booking_email: links.email }, evidence: "email on website" + tabelogNote };
  if (place.reservable === false || (place.primary_type && CASUAL_TYPES.has(place.primary_type))) {
    return { channel: "walkin", patch: tabelogPatch, evidence: "Google: not reservable / casual" + tabelogNote };
  }
  if (place.phone) return { channel: "phone", patch: tabelogPatch, evidence: "phone number only" + tabelogNote };
  return { channel: "unknown", patch: tabelogPatch, evidence: "no booking info found" + tabelogNote };
}

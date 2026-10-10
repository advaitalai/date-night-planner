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
  const tc = html.match(/tablecheck\.com\/(?:[a-z]{2}\/)?(?:shops\/)?([a-z0-9-]+)(?:\/reserve)?/i);
  if (tc && !["en", "ja", "shops", "images", "assets"].includes(tc[1].toLowerCase())) out.tablecheckSlug = tc[1];
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
    const hit = (await tcAutocomplete(place.name)).find((s) => sameName(s.name, place.name));
    if (hit) return { channel: "tablecheck", patch: { tablecheck_slug: hit.slug }, evidence: `TableCheck search: ${hit.name}` };
  } catch {
    // TableCheck unreachable; fall through
  }

  // Tabelog details (URL, score) are worth keeping even when it isn't the booking channel.
  let tabelogPatch: Partial<Place> = {};
  try {
    const tl = links.tabelogUrl ? { url: links.tabelogUrl, ...(await tabelogPageInfo(links.tabelogUrl)) } : await tabelogLookup(place.name);
    if (tl) {
      tabelogPatch = { tabelog_url: tl.url, tabelog_score: tl.score };
      if (tl.netBooking) return { channel: "tabelog", patch: tabelogPatch, evidence: "Tabelog online booking" };
    }
  } catch {
    // Tabelog unreachable; fall through
  }

  if (links.otherOnline) return { channel: "other_online", patch: { ...tabelogPatch, booking_url: links.otherOnline }, evidence: links.otherOnline };
  if (links.email) return { channel: "email", patch: { ...tabelogPatch, booking_email: links.email }, evidence: "email on website" };
  if (place.reservable === false || (place.primary_type && CASUAL_TYPES.has(place.primary_type))) {
    return { channel: "walkin", patch: tabelogPatch, evidence: "Google: not reservable / casual" };
  }
  if (place.phone) return { channel: "phone", patch: tabelogPatch, evidence: "phone number only" };
  return { channel: "unknown", patch: tabelogPatch, evidence: "no booking info found" };
}

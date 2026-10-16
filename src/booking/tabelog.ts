
/**
 * Tabelog lookups: the restaurant's Tabelog page and score, used when working
 * out how a place takes bookings. The bot doesn't book on Tabelog (it needs a
 * login and the site changes often); places with only Tabelog online booking
 * are booked by phone instead.
 */

const RST_URL = /https:\/\/tabelog\.com\/[a-z]+\/A\d{4}\/A\d{6}\/\d+\/?/;

/** First restaurant URL in a Tabelog keyword search, plus whether it takes online bookings. */
export async function tabelogLookup(name: string, area = "東京"): Promise<{ url: string; netBooking: boolean; score: number | null } | null> {
  const q = new URLSearchParams({ sw: name, sa: area });
  const res = await fetch(`https://tabelog.com/rstLst/?${q}`, { headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "ja" } });
  if (!res.ok) return null;
  const html = await res.text();
  const url = html.match(RST_URL)?.[0];
  if (!url) return null;
  return { url: url.endsWith("/") ? url : url + "/", ...(await tabelogPageInfo(url)) };
}

export async function tabelogPageInfo(url: string): Promise<{ netBooking: boolean; score: number | null }> {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "ja" } });
  const html = res.ok ? await res.text() : "";
  return parseTabelogPage(html);
}

export function parseTabelogPage(html: string): { netBooking: boolean; score: number | null } {
  const netBooking = /ネット予約可|空席確認・予約する|ネット予約/.test(html);
  const score = html.match(/rdheader-rating__score-val-dtl[^>]*>\s*([0-9]\.[0-9]{2})/)?.[1];
  return { netBooking, score: score ? Number(score) : null };
}

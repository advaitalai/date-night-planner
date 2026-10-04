import { describe, expect, it } from "vitest";
import { isNonDining, sameName, scanWebsite } from "../src/booking/detect";
import { jaDate, requestEmail } from "../src/booking/email";
import { parseTabelogPage } from "../src/booking/tabelog";
import { parseShop, readCalendar } from "../src/booking/tablecheck";
import { domesticPhone, intlPhone } from "../src/config";
import { buildRaw } from "../src/google/gmail";
import { place } from "./helpers";

const slot = { date: "2026-10-07", time: "18:30", partySize: 2 };

describe("TableCheck availability calendar", () => {
  // Keys are UTC: 09:30Z = 18:30 JST.
  const cal = {
    availability_calendar: {
      data: {
        "2026-10-07": {
          "2026-10-07T09:00:00.000Z": true,
          "2026-10-07T09:30:00.000Z": false,
          "2026-10-07T10:00:00.000Z": true,
          "2026-10-07T12:00:00.000Z": true,
        },
      },
    },
  };

  it("reports the requested slot and nearby free times", () => {
    const r = readCalendar(cal, slot);
    expect(r.status).toBe("unavailable");
    expect(r.alternatives).toEqual(["18:00", "19:00"]);
  });

  it("detects a free slot", () => {
    expect(readCalendar(cal, { ...slot, time: "19:00" }).status).toBe("available");
  });

  it("is unknown for dates without a calendar", () => {
    expect(readCalendar(cal, { ...slot, date: "2026-10-08" }).status).toBe("unknown");
  });

  it("parses shop search results", () => {
    const s = parseShop({
      slug: "ishi",
      name: ["ishi", "ishi"],
      name_translations: [{ translation: "Ishi", locale: "en" }],
      cuisines: ["creative"],
      tags: ["dates"],
      geocode: { lat: 35.6, lon: 139.7 },
      budget_dinner_avg: "12500.0",
      availability: ["2026-10-07"],
    });
    expect(s).toMatchObject({ slug: "ishi", name: "Ishi", lat: 35.6, lng: 139.7, budgetDinnerAvg: 12500, availableDates: ["2026-10-07"] });
  });
});

describe("booking channel detection", () => {
  it("finds booking links on a restaurant website", () => {
    const html = `<a href="https://www.tablecheck.com/ja/shops/monnalisa-ebisu/reserve">予約</a>
      <a href="mailto:info@example.jp?subject=予約">mail</a> <a href="https://tabelog.com/tokyo/A1303/A130302/13001234/">食べログ</a>`;
    expect(scanWebsite(html)).toEqual({ tablecheckSlug: "monnalisa-ebisu", tabelogUrl: "https://tabelog.com/tokyo/A1303/A130302/13001234/", email: "info@example.jp" });
    expect(scanWebsite('<a href="https://www.ebica.jp/pages/shop/1234">book</a>').otherOnline).toContain("ebica.jp");
  });

  it("separates dinner places from spas and galleries", () => {
    expect(isNonDining(place({ primary_type: "spa", types: ["spa"] }))).toBe(true);
    expect(isNonDining(place({ primary_type: "italian_restaurant", types: ["italian_restaurant", "restaurant"] }))).toBe(false);
    expect(isNonDining(place({ primary_type: null, types: ["cafe", "restaurant"] }))).toBe(false);
  });

  it("matches names loosely", () => {
    expect(sameName("Monna Lisa Ebisu", "MONNA LISA 恵比寿 Monna Lisa Ebisu")).toBe(true);
    expect(sameName("Ghungroo", "Nandhini")).toBe(false);
  });

  it("reads Tabelog online booking and score", () => {
    const html = `<b class="c-rating__val rdheader-rating__score-val-dtl">3.62</b> <a>空席確認・予約する</a>`;
    expect(parseTabelogPage(html)).toEqual({ netBooking: true, score: 3.62 });
    expect(parseTabelogPage("<p>電話のみ</p>")).toEqual({ netBooking: false, score: null });
  });
});

describe("reservation emails", () => {
  const contact = { name: "Advait", nameKana: "アドヴァイト", phone: "090-0000-0000", email: "a@example.com" };

  it("formats Japanese dates with the weekday", () => {
    expect(jaDate("2026-10-07", "18:30")).toBe("2026年10月7日（水）18:30");
  });

  it("writes a complete request", () => {
    const { subject, body } = requestEmail(place({ name: "Chez Lui" }), slot, contact, "anniversary");
    expect(subject).toContain("2名");
    expect(body).toContain("Chez Lui ご担当者様");
    expect(body).toContain("・人数：2名");
    expect(body).toContain("キャンセルポリシー");
    expect(body).toContain("備考：anniversary");
    expect(body).toContain("・お名前：アドヴァイト（Advait）");
    // Japanese first, then English
    expect(body.indexOf("ご担当者様")).toBeLessThan(body.indexOf("Dear Chez Lui team"));
    expect(body).toContain("Wednesday 7 October 2026, 18:30");
    expect(body).toContain("+81 90-0000-0000");
  });

  it("formats phone numbers for Japanese and English text", () => {
    expect(intlPhone("070-1568-0178")).toBe("+81 70-1568-0178");
    expect(domesticPhone("+81 070 1568 0178")).toBe("070-1568-0178");
    expect(domesticPhone("+81 70-1568-0178")).toBe("070-1568-0178");
  });

  it("encodes UTF-8 subjects and bodies for Gmail", () => {
    const raw = buildRaw({ to: "x@example.jp", subject: "【ご予約のお願い】", body: "こんにちは" });
    const mime = Buffer.from(raw, "base64url").toString("utf8");
    expect(mime).toContain("Subject: =?UTF-8?B?");
    expect(mime).toContain(Buffer.from("こんにちは").toString("base64"));
  });
});

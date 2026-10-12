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
    expect(scanWebsite('<a href="https://www.tablecheck.com/en/shops/peterluger-pickup/reserve">Order takeout</a>').tablecheckSlug).toBeUndefined();
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

describe("TableCheck seat-only menu", () => {
  it("recognises seat-only items and rejects courses", async () => {
    const { isSeatOnly } = await import("../src/booking/tablecheck");
    expect(isSeatOnly("Reservation for seats only")).toBe(true);
    expect(isSeatOnly("Seat only reservation")).toBe(true);
    expect(isSeatOnly("お席のみのご予約")).toBe(true);
    expect(isSeatOnly("Omakase course")).toBe(false);
    expect(isSeatOnly("Dinner Course A")).toBe(false);
  });
});

describe("TableCheck booked page", () => {
  it("recognises the accepted page", async () => {
    const { isBookedPage } = await import("../src/booking/tablecheck");
    expect(isBookedPage("Your Reservation is Accepted\nAt\nh:armonia\nStatus\nAccepted")).toBe(true);
    expect(isBookedPage("Your selected time is unavailable.")).toBe(false);
  });
});

describe("TableCheck classic menu check", () => {
  it("needs a seat-only item without prepayment", async () => {
    const { parseClassicMenu } = await import("../src/booking/tablecheck");
    const form = `<form id="new_reservation">`;
    const seat = `${form}<div class="menu-item-data" data-id="1" data-name="Reservation for seats only" data-menu-type="main" data-payment-type="none">`;
    const course = `<div class="menu-item-data" data-id="2" data-name="Omakase course" data-payment-type="postpay_optional">`;
    const cardSeat = `<div class="menu-item-data" data-id="3" data-name="Seats only" data-payment-type="prepay">`;
    expect(parseClassicMenu(seat + course)).toBe(true);
    expect(parseClassicMenu(form + course)).toBe(false);
    expect(parseClassicMenu(form + cardSeat + course)).toBe(false);
    expect(parseClassicMenu(`${form}<html>no menu</html>`)).toBe(true);
    expect(parseClassicMenu("<html>403 Forbidden</html>")).toBe(null);
  });

  it("treats plain table bookings as seat-only, never courses, lunch or packages", async () => {
    const { isSeatOnly } = await import("../src/booking/tablecheck");
    for (const n of ["Reservation for seats only", "Book a Table", "Dining Table", "Craft Beer Bar Counter", "【DINNER】Seating only (no meal included)", "お席のみのご予約"]) expect(isSeatOnly(n), n).toBe(true);
    for (const n of ["SMOKEHOUSE Course", "SMOKEHOUSE Course and NOMI HODAI Drink Package", "【LUNCH】Seat-Only Reservation", "【CAFE】Seat-Only Reservation", "Counter omakase", "Regarding Online Reservations", "コース料理", "Anniversary table plan"]) expect(isSeatOnly(n), n).toBe(false);
  });
});

describe("AI phone calls", () => {
  it("formats numbers as E.164 for Vapi", async () => {
    const { toE164 } = await import("../src/booking/phone");
    expect(toE164("03-6431-8960")).toBe("+81364318960");
    expect(toE164("070-1568-0178")).toBe("+817015680178");
    expect(toE164("+81 70-1568-0178")).toBe("+817015680178");
  });

  it("writes a seats-only Japanese script that admits being an AI", async () => {
    const { bookingScript } = await import("../src/booking/phone");
    const s = bookingScript(place({ name: "h:armonia" }), { date: "2026-10-16", time: "18:30", partySize: 2 }, { name: "Advait Alai", nameKana: "アドヴァイト アライ", phone: "070-0000-0000", email: "a@example.com" }, "ja");
    expect(s.firstMessage).toContain("AIアシスタント");
    expect(s.systemPrompt).toContain("席のみ");
    expect(s.systemPrompt).toContain("クレジットカード");
    expect(s.systemPrompt).toContain("10月16日（金）18:30から2名");
    // Booked under a name staff can write, with the 30-minute window, and no policy question.
    expect(s.firstMessage).toContain("エミリー");
    expect(s.systemPrompt).toContain("18:30〜19:00");
    expect(s.systemPrompt).not.toContain("キャンセルポリシー");
  });
});

describe("booking order", () => {
  it("tries booking sites, then email, then phone", async () => {
    process.env.VAPI_API_KEY = "test";
    process.env.VAPI_PHONE_NUMBER_ID = "test";
    const { bookingRoutes } = await import("../src/booking/service");
    const routes = bookingRoutes(place({ tablecheck_slug: "armonia", phone: "03-6431-8960" }));
    expect(routes.map((r) => r.channel)).toEqual(["tablecheck", "phone"]);
    expect(bookingRoutes(place({ tablecheck_slug: null, phone: "03-1111-2222" })).map((r) => r.channel)).toEqual(["phone"]);
    delete process.env.VAPI_API_KEY;
    delete process.env.VAPI_PHONE_NUMBER_ID;
  });

  it("can be limited to one channel (BOOKING_ONLY=phone) and calls you in a dry run", async () => {
    process.env.VAPI_API_KEY = "test";
    process.env.VAPI_PHONE_NUMBER_ID = "test";
    const { config } = await import("../src/config");
    const { bookingRoutes } = await import("../src/booking/service");
    config.booking.only = ["phone"];
    expect(bookingRoutes(place({ tablecheck_slug: "armonia", phone: "03-6431-8960" })).map((r) => r.channel)).toEqual(["phone"]);
    // No number of its own: still callable in a dry run, because the call goes to BOOKING_PHONE.
    expect(bookingRoutes(place({ tablecheck_slug: "armonia", phone: null })).map((r) => r.channel)).toEqual(config.dryRun ? ["phone"] : []);
    config.booking.only = [];
    delete process.env.VAPI_API_KEY;
    delete process.env.VAPI_PHONE_NUMBER_ID;
  });
});

describe("test calls", () => {
  it("sends dry-run calls to the chosen stand-in", async () => {
    const { config, testCallee } = await import("../src/config");
    const saved = { ...config.wa.phones };
    config.wa.phones.Emily = "819000000000";
    expect(testCallee("emily")).toEqual({ label: "Emily", phone: "819000000000" });
    expect(testCallee("")).toEqual({ label: "you", phone: config.booking.contact.phone });
    const { toE164 } = await import("../src/booking/phone");
    expect(toE164("819000000000")).toBe("+819000000000");
    expect(toE164("090-0000-0000")).toBe("+819000000000");
    config.wa.phones = saved;
  });
});

describe("time window", () => {
  it("defaults to 30 minutes later, or the range they gave", async () => {
    const { latestOk, pickInWindow, windowLabel } = await import("../src/booking/window");
    const s = { date: "2026-10-16", time: "18:30", partySize: 2 };
    expect(latestOk(s)).toBe("19:00");
    expect(windowLabel({ ...s, time: "18:00", latest: "19:30" })).toBe("18:00–19:30");
    expect(pickInWindow(["18:00", "19:30", "18:45"], s)).toBe("18:45");
    expect(pickInWindow(["19:30"], s)).toBeNull();
    expect(windowLabel({ ...s, time: "19:00", latest: "19:00" })).toBe("19:00");
  });

  it("states the window and the date in the English script", async () => {
    const { bookingScript } = await import("../src/booking/phone");
    const s = bookingScript(place({ name: "Test" }), { date: "2026-10-16", time: "18:00", latest: "19:30", partySize: 2 }, { name: "Advait Alai", nameKana: "", phone: "070-0000-0000", email: "a@example.com" }, "en");
    expect(s.firstMessage).toContain("calling for Emily");
    expect(s.systemPrompt).toContain("Any time from 18:00 to 19:30 on Friday 16 October");
    expect(s.systemPrompt).toContain("It's for Friday 16 October");
  });
});

describe("cancellation policy lookup", () => {
  it("pulls the passages about cancelling from a page", async () => {
    const { policySnippets } = await import("../src/booking/policy");
    const html = "<html><body><h2>ご予約について</h2><p>キャンセルは前日18時までにご連絡ください。</p><p>当日キャンセルはコース料金の50%</p><script>var cancel=1</script></body></html>";
    const out = policySnippets(html);
    expect(out[0]).toContain("前日18時まで");
    expect(out.join(" ")).not.toContain("var cancel");
  });
});

describe("recognising people in WhatsApp", () => {
  it("normalises saved numbers to WhatsApp's digits", async () => {
    const { waDigits } = await import("../src/config");
    expect(waDigits("+8109012345678")).toBe("819012345678");
    expect(waDigits("+81 90-1234-5678")).toBe("819012345678");
    expect(waDigits("090-1234-5678")).toBe("819012345678");
    expect(waDigits("819012345678")).toBe("819012345678");
  });
});

describe("failure messages", () => {
  it("never shows stack traces or tool names in the chat", async () => {
    const { friendlyError } = await import("../src/booking/service");
    expect(friendlyError("browserType.launchPersistentContext: Executable doesn't exist at /opt/x\n╔══╗")).toBe("the booking browser isn't set up on this machine");
    expect(friendlyError("locator.click: Timeout 30000ms exceeded")).toBe("the booking page took too long to respond");
    expect(friendlyError("The selected time is unavailable")).toBe("The selected time is unavailable");
  });
});

describe("dry runs", () => {
  it("never records a booking a site dry run didn't make", async () => {
    const { freshDb, place } = await import("./helpers");
    freshDb();
    const { recordBooking } = await import("../src/booking/service");
    const { upcomingReservations } = await import("../src/db/repo");
    const out = await recordBooking(place({ name: "h:armonia" }), { date: "2026-10-14", time: "18:30", partySize: 2 }, "tablecheck", { status: "requested", detail: "DRY_RUN: stopped on the confirmation page." });
    expect(out.message).toContain("Dry run");
    expect(out.message).toContain("Nothing is booked");
    expect(upcomingReservations("2026-10-01")).toHaveLength(0);
  });
});

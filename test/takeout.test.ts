import fs from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { listPlaces } from "../src/db/repo";
import { cidFromSavedUrl, importSavedList, parseSavedCsv } from "../src/places/takeout";
import { freshDb } from "./helpers";

const csv = fs.readFileSync(new URL("../fixtures/Tokyo_food.csv", import.meta.url), "utf8");

describe("Takeout saved-list CSV", () => {
  beforeEach(freshDb);

  it("parses every place and skips the blank row", () => {
    const rows = parseSavedCsv(csv);
    expect(rows).toHaveLength(68);
    expect(rows[0].title).toBe("PIZZERIA BRUNA");
    expect(rows.find((r) => r.title === "シバカリーワラ")).toBeTruthy();
  });

  it("extracts the decimal CID from the feature id", () => {
    const url = "https://www.google.com/maps/place/PIZZERIA+BRUNA/data=!4m2!3m1!1s0x60188bb7c80e5f49:0x2fd24b410ce8c10d";
    expect(cidFromSavedUrl(url)).toBe(BigInt("0x2fd24b410ce8c10d").toString());
    expect(cidFromSavedUrl("https://maps.google.com/?cid=123")).toBe("123");
  });

  it("merges the same place saved by both people into one row", async () => {
    await importSavedList(csv, "Tokyo food", "Advait", false);
    const two = "Title,Note,URL\nGhungroo,,https://www.google.com/maps/place/Ghungroo/data=!4m2!3m1!1s0x60188b60748a2411:0x4fb27375453f0e88\n";
    await importSavedList(two, "Want to go", "Emily", false);
    const places = listPlaces();
    expect(places).toHaveLength(68);
    expect(places.find((p) => p.name === "Ghungroo")!.saved_by.sort()).toEqual(["Advait", "Emily"]);
  });
});

describe("cheap import of a big saved list", () => {
  beforeEach(freshDb);

  it("keeps dinner places within reach, skips cafés, far-away and closed places, and merges known ones without a lookup", async () => {
    const { vi } = await import("vitest");
    const { config } = await import("../src/config");
    const before = config.google.mapsKey;
    config.google.mapsKey = "test";
    const url = (name: string, cid: string) => `https://www.google.com/maps/place/${name}/data=!4m2!3m1!1s0x601:${cid}`;
    await importSavedList(`Title,Note,URL\nGhungroo,,${url("Ghungroo", "0x10")}\n`, "Want to go", "Advait", false);
    const google: Record<string, object> = {
      "Izakaya Near": { primaryType: "izakaya_restaurant", types: ["izakaya_restaurant", "restaurant"], location: { latitude: 35.626, longitude: 139.722 }, googleMapsUri: "https://maps.google.com/?cid=17" },
      "Coffee Near": { primaryType: "coffee_shop", types: ["coffee_shop", "cafe"], location: { latitude: 35.626, longitude: 139.722 }, googleMapsUri: "https://maps.google.com/?cid=18" },
      "Kyoto Kaiseki": { primaryType: "japanese_restaurant", types: ["restaurant"], location: { latitude: 35.011, longitude: 135.768 }, googleMapsUri: "https://maps.google.com/?cid=19" },
      "Gone Bistro": { primaryType: "french_restaurant", types: ["restaurant"], businessStatus: "CLOSED_PERMANENTLY", location: { latitude: 35.626, longitude: 139.722 }, googleMapsUri: "https://maps.google.com/?cid=20" },
    };
    const calls: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const u = String(input);
      calls.push(u);
      if (u.includes("searchText")) {
        const q = JSON.parse(String(init?.body)).textQuery as string;
        expect((init?.headers as Record<string, string>)["X-Goog-FieldMask"]).toBe("places.id"); // ids only: no charge
        return new Response(JSON.stringify({ places: google[q] ? [{ id: q }] : [] }));
      }
      const id = decodeURIComponent(u.split("/places/")[1].split("?")[0]);
      return new Response(JSON.stringify({ id, displayName: { text: id }, ...google[id] }));
    });
    const csv = ["Title,Note,URL", `Ghungroo,,${url("Ghungroo", "0x10")}`, `Izakaya Near,,${url("a", "0x11")}`, `Coffee Near,,${url("b", "0x12")}`, `Kyoto Kaiseki,,${url("c", "0x13")}`, `Gone Bistro,,${url("d", "0x14")}`, `Nowhere,,${url("e", "0x15")}`].join("\n");
    const r = await importSavedList(csv, "Japan", "Emily", true);
    fetchSpy.mockRestore();
    config.google.mapsKey = before;
    expect(r).toMatchObject({ rows: 6, imported: 1, alreadyKnown: 1, unresolved: ["Nowhere"], skipped: { notDinner: ["Coffee Near"], tooFar: ["Kyoto Kaiseki"], closed: ["Gone Bistro"] } });
    expect(calls.some((c) => c.includes("Ghungroo"))).toBe(false); // known place: no lookup
    const places = listPlaces();
    expect(places.map((p) => p.name).sort()).toEqual(["Ghungroo", "Izakaya Near"]);
    expect(places.find((p) => p.name === "Ghungroo")!.saved_by.sort()).toEqual(["Advait", "Emily"]);
    const izakaya = places.find((p) => p.name === "Izakaya Near")!;
    expect(izakaya).toMatchObject({ lat: 35.626, saved_by: ["Emily"], google_place_id: null }); // full details later, only if it's near a date
  });
});

describe("date spot tags (Emily, 7 Nov)", () => {
  const csv = [
    "Title,Note,URL,Tags,Comment",
    'cado,,https://www.google.com/maps/place/cado/data=!4m2!3m1!1s0x60188b1b2b2b2b2b:0x8bc8a7f1a2b3c4d5,"date night",',
    'Ramen Taro,,https://www.google.com/maps/place/x/data=!4m2!3m1!1s0x60188b1b2b2b2b2c:0x1111111111111111,"quick, cheap",',
    'New Bistro,,https://www.google.com/maps/place/y/data=!4m2!3m1!1s0x60188b1b2b2b2b2d:0x2222222222222222,Date,',
    // Emily's real export (7 Nov): "Dates 🌹🥀", and several tags joined with ";".
    'Etruschi,Pretty looking ,https://www.google.com/maps/place/Etruschi/data=!4m2!3m1!1s0x60188b61c32d1793:0x22905fdeedc2c147, Dates 🌹🥀,',
    'Up To Date Cafe,,https://www.google.com/maps/place/z/data=!4m2!3m1!1s0x60188b1b2b2b2b2e:0x3333333333333333,"Brunch; Dates 🌹🥀",',
    'Updated Bar,,https://www.google.com/maps/place/w/data=!4m2!3m1!1s0x60188b1b2b2b2b2f:0x4444444444444444,Updates,',
  ].join("\n");

  it("reads a date tag from the Tags column", async () => {
    const { parseSavedCsv } = await import("../src/places/takeout");
    expect(parseSavedCsv(csv).map((r) => [r.title, r.dateSpot])).toEqual([
      ["cado", true],
      ["Ramen Taro", false],
      ["New Bistro", true],
      ["Etruschi", true],
      ["Up To Date Cafe", true],
      ["Updated Bar", false],
    ]);
  });

  it("--tags-only marks known places and adds nothing, with no Google lookups", async () => {
    const { freshDb } = await import("./helpers");
    freshDb();
    const { vi } = await import("vitest");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { importSavedList, parseSavedCsv } = await import("../src/places/takeout");
    const { upsertPlace, listPlaces } = await import("../src/db/repo");
    const [cado, ramen] = parseSavedCsv(csv);
    upsertPlace({ cid: cado.cid, name: "cado", source: "takeout:Want to go", saved_by: ["Emily"] });
    upsertPlace({ cid: ramen.cid, name: "Ramen Taro", source: "takeout:Want to go", saved_by: ["Emily"] });
    const r = await importSavedList(csv, "Want to go", "Emily", true, undefined, true);
    expect(r.alreadyKnown).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
    const byName = Object.fromEntries(listPlaces().map((p) => [p.name, p.date_spot]));
    expect(byName).toEqual({ cado: true, "Ramen Taro": false });
    fetchSpy.mockRestore();
  });
});

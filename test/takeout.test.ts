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

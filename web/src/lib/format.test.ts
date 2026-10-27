import { describe, expect, it } from "vitest";
import { commuteLines, deviationLabel, letLabel, postcodeDistrict, weeklyPrice } from "./format";
import { isoWeek } from "./week";

describe("commuteLines", () => {
  it("prefers walking when it is short enough", () => {
    expect(commuteLines({ walkMin: 22, transitMin: 8, transitSummary: "Bus 65" })).toEqual({
      main: "22 Min. zu Fuß",
      alt: "8 Min. mit Bus 65",
    });
  });

  it("falls back to the fastest option", () => {
    expect(commuteLines({ walkMin: 70, transitMin: 28, driveMin: 12 })).toEqual({
      main: "12 Min. mit dem Auto",
      alt: "28 Min. mit ÖPNV",
    });
  });

  it("handles missing data", () => {
    expect(commuteLines(null)).toEqual({ main: null, alt: null });
  });
});

describe("labels", () => {
  it("describes the let type with its term", () => {
    expect(letLabel({ letType: "short_let", minTermMonths: 2, maxTermMonths: 5 })).toBe("Short Let, 2–5 Monate");
    expect(letLabel({ letType: "short_let", minTermMonths: 6, maxTermMonths: 6 })).toBe("Short Let, 6 Monate");
    expect(letLabel({ letType: "corporate", maxTermMonths: 10 })).toBe("Corporate Let, max. 10 Monate");
    expect(letLabel({ letType: "periodic" })).toBe("Unbefristete Miete");
  });

  it("names the deviation like the prototype", () => {
    expect(deviationLabel(4, 4)).toEqual({ text: "Treffer", hit: true });
    expect(deviationLabel(3, 4)).toEqual({ text: "Knapp daneben", hit: true });
    expect(deviationLabel(1, 4)).toEqual({ text: "3 daneben", hit: false });
  });

  it("converts and shortens", () => {
    expect(weeklyPrice(6865)).toBe(1584);
    expect(postcodeDistrict("TW10 7")).toBe("TW10");
  });
});

describe("isoWeek", () => {
  it("uses ISO-8601 weeks", () => {
    expect(isoWeek(new Date(2026, 9, 27))).toBe("2026-W44");
    expect(isoWeek(new Date(2026, 10, 15))).toBe("2026-W46"); // Sunday belongs to the week before Monday
    expect(isoWeek(new Date(2027, 0, 1))).toBe("2026-W53");
  });
});

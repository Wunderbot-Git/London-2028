import { describe, expect, it } from "vitest";
import { commuteLines, deviationLabel, letLabel, listingPhoto, photoCandidates, postcodeDistrict, propertyTypeLabel, sourceLabel, weeklyPrice } from "./format";
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

describe("listingPhoto", () => {
  it("picks the listing photo and skips banners and tracking pixels (real alert mails)", () => {
    expect(listingPhoto([
      "https://mns.asrvkeez.com/imp/2/ec8d02bf/abc?segment=",
      "https://lid.zoocdn.com/645/430/9fd8cfd0.jpg",
    ])).toBe("https://lid.zoocdn.com/645/430/9fd8cfd0.jpg");
    expect(listingPhoto([
      "http://media.onthemarket.com/properties/20652669/1655426553/image-0-480x320.jpg",
      "https://media.onthemarket.com/agent-products/internal-alert-banners/x-Email.png",
    ])).toBe("https://media.onthemarket.com/properties/20652669/1655426553/image-0-480x320.jpg");
    expect(listingPhoto(["https://media.onthemarket.com/email/rating_stars.png"])).toBeNull();
    expect(listingPhoto(undefined)).toBeNull();
  });
  it("names OnTheMarket however the listing came in", () => {
    expect(sourceLabel("onthemarket")).toBe("OnTheMarket");
    expect(sourceLabel("agency:onthemarket.com")).toBe("OnTheMarket");
  });
});

describe("photoCandidates", () => {
  it("tries a larger size first where the image server has one", () => {
    const rm = "https://media.rightmove.co.uk/dir/crop/10:9-16:9/property-photo/42d1691ee/91355817/42d_max_296x197.jpeg";
    expect(photoCandidates(rm)).toEqual([rm.replace("296x197", "656x437"), rm]);
    expect(photoCandidates("https://lid.zoocdn.com/645/430/abc.jpg")).toEqual(["https://lid.zoocdn.com/1024/768/abc.jpg", "https://lid.zoocdn.com/645/430/abc.jpg"]);
    expect(photoCandidates("https://media.onthemarket.com/properties/1/2/image-0-480x320.jpg")).toEqual(["https://media.onthemarket.com/properties/1/2/image-0-480x320.jpg"]);
    expect(photoCandidates(null)).toEqual([]);
  });
});

describe("propertyTypeLabel", () => {
  it("names the property type, nothing when unknown", () => {
    expect(propertyTypeLabel("semi_detached")).toBe("Doppelhaushälfte");
    expect(propertyTypeLabel("unknown")).toBeNull();
    expect(propertyTypeLabel(undefined)).toBeNull();
  });
});

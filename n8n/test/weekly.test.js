import { describe, expect, it } from "vitest";
import { batchMetrics, combined, isoWeek, phaseCheck, ratingsByListing, reviewWeek, selectBatch, settleBatch } from "../src/weekly.js";
import { backtestRequest, backtestSample, decide, derivationRequest, examplesFor, readBacktest, readCandidate, ratedListings, shouldUpdate } from "../src/profile.js";
import { updateWrite } from "../src/firestore.js";

const L = (id, score, extra = {}) => ({ id, prediction: score == null ? null : { score }, postcode: "TW10 7", priceMonthly: 5000, flags: [], ...extra });
const R = (listingId, rater, score, extra = {}) => ({ listingId, rater, score, tags: [], note: "", predictionAtRating: 3, createdAt: "2026-11-10T10:00:00Z", ...extra });
const answer = (obj) => ({ modelVersion: "m", candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(obj) }] } }] });

describe("weeks", () => {
  it("names the review week after a Sunday run", () => {
    expect(isoWeek(new Date("2026-11-15T18:00:00Z"))).toBe("2026-W46");
    expect(reviewWeek(new Date("2026-11-15T18:00:00Z"))).toBe("2026-W47");
    expect(reviewWeek(new Date("2026-12-27T18:00:00Z"))).toBe("2026-W53");
  });
});

describe("selectBatch", () => {
  const pool = [
    ...[5, 5, 4, 4, 4, 4, 3, 3, 2, 2, 1, 1].map((s, i) => L(`a${i}`, s)),
    L("noscore", null),
    L("far", 2, { postcode: "SW19 4", priceMonthly: 9500 }),
    L("dup", 5, { duplicateOf: "a0" }),
  ];
  it("mixes top, unsure and atypical and leaves out duplicates", () => {
    const b = selectBatch(pool, { size: 10, seed: "2026-W47" });
    expect(b).toHaveLength(10);
    const why = (id) => b.find((x) => x.id === id)?.why;
    expect(b.filter((x) => x.why === "top")).toHaveLength(5);
    expect(b.filter((x) => x.why === "unsure")).toHaveLength(3);
    expect(b.filter((x) => x.why === "atypical")).toHaveLength(2);
    expect(why("a0")).toBe("top");
    expect(why("noscore")).toBe("unsure");
    expect(why("far")).toBe("atypical");
    expect(why("dup")).toBeUndefined();
  });
  it("is stable per week and takes everything when there is little", () => {
    expect(selectBatch(pool, { size: 10, seed: "x" })).toEqual(selectBatch(pool, { size: 10, seed: "x" }));
    expect(selectBatch(pool.slice(0, 3), { size: 12, seed: "x" })).toHaveLength(3);
    expect(selectBatch([], { size: 12 })).toEqual([]);
  });
});

describe("metrics", () => {
  const byListing = ratingsByListing([
    R("a", "philipp", 4), R("a", "manuela", 1),
    R("b", "philipp", 3), R("b", "manuela", 3),
    R("c", "philipp", null),
  ]);
  it("measures prediction, agreement and coverage", () => {
    const m = batchMetrics({ listingIds: ["a", "b", "c", "d"] }, byListing, [{}, {}, { duplicateOf: "x" }]);
    expect(m.philipp).toEqual({ n: 2, mae: 0.5, hitRateWithin1: 1 });
    expect(m.manuela).toEqual({ n: 2, mae: 1, hitRateWithin1: 0.5 });
    expect(m.agreement).toBe(0.5);
    expect(m.disagreements).toEqual(["a"]);
    expect(m.coverage).toEqual({ listings: 3, new: 2, duplicates: 1 });
    expect(combined(byListing.a)).toBe(2.5);
  });
  it("settles a batch: seen → reviewed, unseen → new", () => {
    expect(settleBatch({ listingIds: ["a", "c", "d"] }, byListing)).toEqual([
      { id: "a", status: "reviewed" }, { id: "c", status: "reviewed" }, { id: "d", status: "new" },
    ]);
  });
  it("counts consecutive weeks at ≥ 80 % within ±1 for Philipp", () => {
    const wk = (hit, n = 10) => ({ metrics: { philipp: { n, hitRateWithin1: hit } } });
    expect(phaseCheck([wk(0.9), wk(0.8), wk(0.85), wk(1), wk(0.5)])).toEqual({ weeksAtTarget: 4, readyForHunt: true });
    expect(phaseCheck([wk(0.9), wk(0.7), wk(1)])).toEqual({ weeksAtTarget: 1, readyForHunt: false });
    expect(phaseCheck([wk(1, 3)])).toEqual({ weeksAtTarget: 0, readyForHunt: false });
    expect(phaseCheck([])).toEqual({ weeksAtTarget: 0, readyForHunt: false });
  });
});

describe("profile update", () => {
  const listings = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`l${i}`, { address: `Road ${i}`, postcode: "TW10", priceMonthly: 4000 + i * 100, furnished: "furnished", letType: "short_let", beds: 3, flags: [] }]));
  const ratings = Object.keys(listings).flatMap((id, i) => [R(id, "philipp", (i % 5) + 1, { createdAt: `2026-11-${String(10 + i).padStart(2, "0")}T10:00:00Z`, tags: i % 2 ? ["Lage"] : [] }), R(id, "manuela", (i % 5) + 1)]);
  const rated = ratedListings(ratingsByListing(ratings), listings);

  it("waits for 15 ratings and for new ones", () => {
    expect(shouldUpdate(null, 14)).toBe(false);
    expect(shouldUpdate(null, 15)).toBe(true);
    expect(shouldUpdate({ basedOnRatings: 20 }, 20)).toBe(false);
    expect(shouldUpdate({ basedOnRatings: 20 }, 21)).toBe(true);
  });

  it("asks Gemini with every rating, including tags", () => {
    const r = derivationRequest(rated, null, {});
    const user = r.contents[0].parts[0].text;
    expect(user).toContain("Bewertete Inserate (20)");
    expect(user).toContain("ID l1\n");
    expect(user).toContain("Philipp: 2 (Lage)");
    expect(r.generationConfig.thinkingConfig.thinkingLevel).toBe("high");
    expect(r.generationConfig.responseJsonSchema.properties.rules).toBeDefined();
  });

  it("keeps confirmed hard filters and drops unknown few-shot ids", () => {
    const body = answer({ rules: [" Garten zählt ", ""], fewShot: ["l1", "l2", "l2", "nope"], suggestedHardFilters: { maxPriceMonthly: 7000, minBeds: null, maxCommuteMin: null }, summary: "S" });
    const c = readCandidate(body, rated, { version: 2, hardFilters: { minBeds: 3 } }, new Date("2026-11-15T18:00:00Z"));
    expect(c).toMatchObject({ version: 3, basedOnRatings: 20, hardFilters: { minBeds: 3 }, rules: ["Garten zählt"], fewShot: ["l1", "l2"], confirmedBy: [] });
    expect(c.suggestedHardFilters.maxPriceMonthly).toBe(7000);
  });

  it("backtests on recent listings outside both example sets and adopts only on lower MAE", () => {
    const sample = backtestSample(rated, ["l19", "l0"], 5);
    expect(sample.map((x) => x.id)).toEqual(["l18", "l17", "l16", "l15", "l14"]);
    const req = backtestRequest(sample, { profile: null, examples: examplesFor(["l1"], rated) });
    expect(req.systemInstruction.parts[0].text).toContain("Beispiel 1 – Bewertung 2");
    const exact = readBacktest(answer({ scores: sample.map((x) => ({ id: x.id, score: x.combined })) }), sample);
    const off = readBacktest(answer({ scores: sample.map((x) => ({ id: x.id, score: x.combined > 3 ? 1 : 5 })) }), sample);
    expect(exact).toEqual({ n: 5, mae: 0, hitRateWithin1: 1 });
    expect(off.mae).toBeGreaterThan(2);
    expect(decide(off, exact).adopt).toBe(true);
    expect(decide(exact, off).adopt).toBe(false);
    expect(decide(exact, exact).adopt).toBe(false);
    expect(decide(null, exact).adopt).toBe(true);
  });
});

describe("updateWrite", () => {
  it("masks only the given fields", () => {
    expect(updateWrite("n", { status: "queued" })).toEqual({ update: { name: "n", fields: { status: { stringValue: "queued" } } }, updateMask: { fieldPaths: ["status"] } });
    expect(updateWrite("n", { a: 1 }, { merge: false }).updateMask).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { agreementRate, combinedScore, disagreements, predictionMetrics, tagHints } from "./metrics";
import type { Rating } from "./types";

const r = (listingId: string, score: number | null, pred: number | null, tags: string[] = []): Rating => ({
  listingId,
  rater: "philipp",
  score,
  tags,
  note: "",
  predictionAtRating: pred,
  createdAt: "2026-11-08T10:00:00Z",
});

describe("predictionMetrics", () => {
  it("computes MAE and ±1 hit rate, ignoring skipped and unpredicted listings", () => {
    const m = predictionMetrics([r("a", 4, 4), r("b", 2, 4), r("c", 5, 4), r("d", null, 3), r("e", 3, null)]);
    expect(m.n).toBe(3);
    expect(m.mae).toBeCloseTo(1);
    expect(m.hitsWithin1).toBe(2);
    expect(m.hitRateWithin1).toBeCloseTo(2 / 3);
  });

  it("returns nulls when nothing is comparable", () => {
    expect(predictionMetrics([r("a", null, 3)])).toEqual({ n: 0, mae: null, hitsWithin1: 0, hitRateWithin1: null });
  });
});

describe("two raters", () => {
  const byRater = {
    philipp: { a: r("a", 5, 4), b: r("b", 2, 3), c: r("c", 3, 3) },
    manuela: { a: { ...r("a", 2, 4), rater: "manuela" as const }, b: { ...r("b", 3, 3), rater: "manuela" as const } },
  };

  it("flags a gap of 2 or more", () => {
    expect(disagreements(["a", "b", "c"], byRater)).toEqual(["a"]);
  });

  it("measures agreement only where both rated", () => {
    expect(agreementRate(["a", "b", "c"], byRater)).toBeCloseTo(0.5);
  });

  it("averages both scores, or uses the single one", () => {
    expect(combinedScore("a", byRater)).toBe(3.5);
    expect(combinedScore("c", byRater)).toBe(3);
    expect(combinedScore("x", byRater)).toBeNull();
  });
});

describe("tagHints", () => {
  it("reports tags used twice with a clearly low or high average", () => {
    const hints = tagHints([
      r("a", 1, 3, ["Zu weit"]),
      r("b", 2, 3, ["Zu weit", "Lage"]),
      r("c", 5, 4, ["Lage"]),
      r("d", 4, 4, ["Das Haus"]),
    ]);
    expect(hints).toEqual(["„Zu weit“ senkt die Bewertung deutlich."]);
  });
});

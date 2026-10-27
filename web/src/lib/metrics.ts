// Weekly metrics from spec §6.3/§6.4.
import type { Listing, Rater, Rating } from "./types";

export interface PredictionMetrics {
  n: number;
  mae: number | null;
  hitsWithin1: number;
  hitRateWithin1: number | null;
}

/** MAE and ±1 hit rate for one rater; skipped ratings and listings without prediction are ignored. */
export function predictionMetrics(ratings: Rating[]): PredictionMetrics {
  const scored = ratings.filter(
    (r): r is Rating & { score: number; predictionAtRating: number } =>
      r.score != null && r.predictionAtRating != null,
  );
  const n = scored.length;
  if (!n) return { n: 0, mae: null, hitsWithin1: 0, hitRateWithin1: null };
  const diffs = scored.map((r) => Math.abs(r.score - r.predictionAtRating));
  const hits = diffs.filter((d) => d <= 1).length;
  return { n, mae: diffs.reduce((a, b) => a + b, 0) / n, hitsWithin1: hits, hitRateWithin1: hits / n };
}

export type RatingsByRater = Partial<Record<Rater, Record<string, Rating>>>;

/** Listings both rated with a gap of 2 or more (spec §6.3 "Uneinigkeit"). */
export function disagreements(listingIds: string[], byRater: RatingsByRater): string[] {
  return listingIds.filter((id) => {
    const p = byRater.philipp?.[id]?.score;
    const m = byRater.manuela?.[id]?.score;
    return p != null && m != null && Math.abs(p - m) >= 2;
  });
}

/** Share of listings rated by both with a gap ≤ 1 (spec §6.4 "Einigkeit"). */
export function agreementRate(listingIds: string[], byRater: RatingsByRater): number | null {
  const both = listingIds.filter(
    (id) => byRater.philipp?.[id]?.score != null && byRater.manuela?.[id]?.score != null,
  );
  if (!both.length) return null;
  const agree = both.filter(
    (id) => Math.abs(byRater.philipp![id].score! - byRater.manuela![id].score!) <= 1,
  ).length;
  return agree / both.length;
}

/** Mean of both raters' scores, or the single score if only one rated (feeds the prediction). */
export function combinedScore(id: string, byRater: RatingsByRater): number | null {
  const s = [byRater.philipp?.[id]?.score, byRater.manuela?.[id]?.score].filter(
    (x): x is number => x != null,
  );
  return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null;
}

/**
 * Quick hints from this week's tags until the weekly profile update exists:
 * tags used at least twice with a clearly low or high average score.
 */
export function tagHints(ratings: Rating[]): string[] {
  const byTag = new Map<string, number[]>();
  for (const r of ratings) {
    if (r.score == null) continue;
    for (const t of r.tags) byTag.set(t, [...(byTag.get(t) ?? []), r.score]);
  }
  const hints: string[] = [];
  [...byTag.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .forEach(([tag, scores]) => {
      if (scores.length < 2) return;
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      if (avg <= 2.2) hints.push(`„${tag}“ senkt die Bewertung deutlich.`);
      else if (avg >= 3.8) hints.push(`„${tag}“ steht bei den Favoriten.`);
    });
  return hints;
}

export function favourite(ratings: Rating[], listings: Listing[]): Listing | null {
  const best = ratings
    .filter((r) => r.score != null)
    .sort((a, b) => b.score! - a.score! || a.createdAt.localeCompare(b.createdAt))[0];
  return best ? (listings.find((l) => l.id === best.listingId) ?? null) : null;
}

// Weekly batch (spec §6.2), batch metrics (§6.4) and the phase-1 → 2 check (§3).

const RATERS = ["philipp", "manuela"];

/** ISO week key ("2026-W47") of a date. */
export function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** The batch built on Sunday is reviewed in the week that starts the next day. */
export function reviewWeek(now = new Date()) {
  const monday = new Date(now.getTime());
  monday.setUTCDate(monday.getUTCDate() + (((8 - monday.getUTCDay()) % 7) || 7));
  return isoWeek(monday);
}

// Small deterministic PRNG so a re-run for the same week picks the same batch.
function rng(seed) {
  let h = 1779033703 ^ seed.length;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 3432918353), (h = (h << 13) | (h >>> 19));
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

const score = (l) => l.prediction?.score ?? null;
const priceBand = (l) => (l.priceMonthly == null ? "?" : String(Math.floor(l.priceMonthly / 1000)));
const areaOf = (l) => (l.postcode || "").split(" ")[0] || l.area || "?";

/**
 * Picks the weekly batch from unrated, non-duplicate listings (spec §6.2):
 * ~50 % highest prediction, ~30 % most uncertain (score near 3, no score, or many flags),
 * ~20 % deliberately atypical (area or price band not yet in the batch).
 * Returns ids with the share each came from, shuffled so the order does not give the mix away.
 */
export function selectBatch(candidates, { size = 12, seed = "" } = {}) {
  const pool = candidates.filter((l) => !l.duplicateOf);
  const n = Math.min(size, pool.length);
  const rand = rng(seed);
  const tiebreak = new Map(pool.map((l) => [l.id, rand()]));
  const picked = [];
  const take = (list, k, why) => {
    for (const l of list) {
      if (k <= 0) break;
      if (picked.some((p) => p.id === l.id)) continue;
      picked.push({ id: l.id, why, listing: l });
      k--;
    }
  };
  const rest = () => pool.filter((l) => !picked.some((p) => p.id === l.id));

  const nTop = Math.round(n * 0.5);
  const nUnsure = Math.round(n * 0.3);
  take(
    rest().filter((l) => score(l) != null).sort((a, b) => score(b) - score(a) || tiebreak.get(a.id) - tiebreak.get(b.id)),
    nTop,
    "top",
  );
  const unsureness = (l) => (score(l) == null ? -1 : Math.abs(score(l) - 3) - 0.25 * (l.flags?.length ?? 0));
  take(rest().sort((a, b) => unsureness(a) - unsureness(b) || tiebreak.get(a.id) - tiebreak.get(b.id)), nUnsure, "unsure");
  // Atypical: one point each for an area and a price band the batch does not have yet.
  while (picked.length < n) {
    const areas = new Set(picked.map((p) => areaOf(p.listing)));
    const bands = new Set(picked.map((p) => priceBand(p.listing)));
    const novelty = (l) => (areas.has(areaOf(l)) ? 0 : 1) + (bands.has(priceBand(l)) ? 0 : 1);
    const next = rest().sort((a, b) => novelty(b) - novelty(a) || tiebreak.get(a.id) - tiebreak.get(b.id))[0];
    take([next], 1, "atypical");
  }

  const order = picked.map((p) => ({ ...p, r: rand() })).sort((a, b) => a.r - b.r);
  return order.map(({ id, why }) => ({ id, why }));
}

/** ratings (flat list) → { listingId: { philipp?: rating, manuela?: rating } } */
export function ratingsByListing(ratings) {
  const out = {};
  for (const r of ratings) (out[r.listingId] ??= {})[r.rater] = r;
  return out;
}

/** Mean of the scores both gave (skips excluded), or null. */
export function combined(byRater) {
  const s = RATERS.map((r) => byRater?.[r]?.score).filter((x) => x != null);
  return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null;
}

function predictionStats(rs) {
  const scored = rs.filter((r) => r.score != null && r.predictionAtRating != null);
  if (!scored.length) return { n: 0, mae: null, hitRateWithin1: null };
  const d = scored.map((r) => Math.abs(r.score - r.predictionAtRating));
  return { n: d.length, mae: d.reduce((a, b) => a + b, 0) / d.length, hitRateWithin1: d.filter((x) => x <= 1).length / d.length };
}

/**
 * Metrics of one finished batch (spec §6.4): per rater MAE and ±1 hit rate against the
 * prediction shown at rating time, agreement between the two, and coverage of the week.
 */
export function batchMetrics(batch, byListing, weekListings = []) {
  const per = Object.fromEntries(
    RATERS.map((rater) => [rater, predictionStats(batch.listingIds.map((id) => byListing[id]?.[rater]).filter(Boolean))]),
  );
  const both = batch.listingIds.filter((id) => byListing[id]?.philipp?.score != null && byListing[id]?.manuela?.score != null);
  const agree = both.filter((id) => Math.abs(byListing[id].philipp.score - byListing[id].manuela.score) <= 1).length;
  return {
    ...per,
    agreement: both.length ? agree / both.length : null,
    disagreements: both.filter((id) => Math.abs(byListing[id].philipp.score - byListing[id].manuela.score) >= 2),
    coverage: {
      listings: weekListings.length,
      new: weekListings.filter((l) => !l.duplicateOf).length,
      duplicates: weekListings.filter((l) => l.duplicateOf).length,
    },
  };
}

// A week counts towards the phase-2 criterion only with enough of Philipp's ratings.
export const MIN_WEEKLY_RATINGS = 5;
export const TARGET_HIT_RATE = 0.8;
export const TARGET_WEEKS = 4;

/**
 * Spec §3: the prediction is within ±1 of Philipp's rating in at least 80 % of cases,
 * for at least 4 consecutive weeks. `batches` newest first, each with `metrics`.
 */
export function phaseCheck(batches) {
  let streak = 0;
  for (const b of batches) {
    const m = b.metrics?.philipp;
    if (!m || m.n < MIN_WEEKLY_RATINGS || m.hitRateWithin1 < TARGET_HIT_RATE) break;
    streak++;
  }
  return { weeksAtTarget: streak, readyForHunt: streak >= TARGET_WEEKS };
}

/**
 * Status changes for the listings of a finished batch: seen by anyone (rated or skipped) →
 * reviewed; seen by no one → new again, so it can come back in a later batch.
 */
export function settleBatch(batch, byListing) {
  return batch.listingIds.map((id) => {
    const seen = RATERS.some((r) => byListing[id]?.[r]);
    return { id, status: seen ? "reviewed" : "new" };
  });
}

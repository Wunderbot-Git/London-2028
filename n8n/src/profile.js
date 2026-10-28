// Weekly profile update (spec §6.3): Gemini derives rules and few-shot examples from all
// ratings; the new profile replaces the old one only if it predicts the past ratings better.
// Hard filters are never set automatically, only suggested.
import { describe, geminiRequest, judgeSystem, readJson } from "./gemini.js";
import { combined } from "./weekly.js";

export const MIN_RATINGS = 15;
export const BACKTEST_SIZE = 40;

/** Rated listings: [{ id, listing, byRater, combined, lastRatedAt }] (combined score not null). */
export function ratedListings(byListing, listingsById) {
  return Object.entries(byListing)
    .map(([id, byRater]) => ({
      id,
      listing: listingsById[id],
      byRater,
      combined: combined(byRater),
      lastRatedAt: Object.values(byRater).map((r) => r.createdAt ?? "").sort().pop() ?? "",
    }))
    .filter((x) => x.listing && x.combined != null);
}

/** Update once enough ratings exist and something new was rated since the last profile. */
export function shouldUpdate(profile, ratedCount) {
  return ratedCount >= MIN_RATINGS && ratedCount > (profile?.basedOnRatings ?? 0);
}

const nullableInt = { type: ["integer", "null"] };
export const DERIVATION_SCHEMA = {
  type: "object",
  properties: {
    rules: { type: "array", items: { type: "string" } },
    fewShot: { type: "array", items: { type: "string" } },
    suggestedHardFilters: {
      type: "object",
      properties: { maxPriceMonthly: nullableInt, minBeds: nullableInt, maxCommuteMin: nullableInt },
      required: ["maxPriceMonthly", "minBeds", "maxCommuteMin"],
      additionalProperties: false,
    },
    summary: { type: "string" },
  },
  required: ["rules", "fewShot", "suggestedHardFilters", "summary"],
  additionalProperties: false,
};

const rater = (r) =>
  r
    ? r.score == null
      ? "übersprungen"
      : `${r.score}${r.tags?.length ? ` (${r.tags.join(", ")})` : ""}${r.note ? ` – „${r.note}“` : ""}`
    : "nicht bewertet";

export function derivationRequest(rated, profile, criteria) {
  const blocks = rated
    .map((x) =>
      [
        `ID ${x.id}`,
        describe(x.listing),
        `Philipp: ${rater(x.byRater.philipp)}`,
        `Manuela: ${rater(x.byRater.manuela)}`,
        x.listing.prediction?.score != null ? `Damalige Prognose: ${x.listing.prediction.score}` : null,
      ].filter(Boolean).join("\n"),
    )
    .join("\n\n");
  const system = `${judgeSystem({ profile, criteria, examples: [] })}

Deine Aufgabe jetzt: Leite aus allen Bewertungen der Familie ein neues Präferenzprofil ab.
- rules: höchstens 10 kurze deutsche Regeln, konkret und prüfbar (z. B. „Garten wichtiger als ein 4. Schlafzimmer“, „Über £6.500 nur mit Nebenkosten inklusive“). Nur was die Bewertungen, Gründe und Notizen tragen; Widersprüche zwischen Philipp und Manuela benennen statt glätten.
- fewShot: 6 bis 10 IDs besonders aussagekräftiger Bewertungen, über die ganze Skala verteilt.
- suggestedHardFilters: nur wo die Bewertungen eine klare Grenze zeigen, sonst null. Das ist ein Vorschlag; die Familie bestätigt ihn selbst.
- summary: zwei, drei Sätze, was sich gegenüber dem bisherigen Profil ändert.`;
  return geminiRequest({
    system,
    user: `Bewertete Inserate (${rated.length}):\n\n${blocks}`,
    schema: DERIVATION_SCHEMA,
    thinkingLevel: "high",
    maxOutputTokens: 32768,
  });
}

/** Gemini's answer → candidate profile document (spec §5.4 `profiles/{version}`). */
export function readCandidate(body, rated, profile, now = new Date()) {
  const d = readJson(body);
  const ids = new Set(rated.map((x) => x.id));
  return {
    version: (profile?.version ?? 0) + 1,
    createdAt: now.toISOString(),
    basedOnRatings: rated.length,
    hardFilters: profile?.hardFilters ?? {},
    suggestedHardFilters: d.suggestedHardFilters,
    rules: d.rules.map((r) => r.trim()).filter(Boolean).slice(0, 10),
    fewShot: [...new Set(d.fewShot)].filter((id) => ids.has(id)).slice(0, 10),
    summary: d.summary,
    metrics: null,
    confirmedBy: [],
  };
}

/** Few-shot examples for a profile from data already in memory. */
export function examplesFor(ids, rated) {
  return (ids ?? [])
    .map((id) => rated.find((x) => x.id === id))
    .filter(Boolean)
    .map((x) => ({
      listing: x.listing,
      score: Math.round(x.combined * 2) / 2,
      tags: [...new Set(Object.values(x.byRater).flatMap((r) => r.tags ?? []))],
      notes: Object.values(x.byRater).map((r) => r.note).filter(Boolean),
    }));
}

/** Most recently rated listings that neither profile uses as an example. */
export function backtestSample(rated, exclude, size = BACKTEST_SIZE) {
  const skip = new Set(exclude);
  return rated
    .filter((x) => !skip.has(x.id))
    .sort((a, b) => b.lastRatedAt.localeCompare(a.lastRatedAt))
    .slice(0, size);
}

export const BACKTEST_SCHEMA = {
  type: "object",
  properties: {
    scores: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, score: { type: "integer", enum: [1, 2, 3, 4, 5] } },
        required: ["id", "score"],
        additionalProperties: false,
      },
    },
  },
  required: ["scores"],
  additionalProperties: false,
};

/** One request scores the whole sample with a given profile (same system prompt as ingest). */
export function backtestRequest(sample, context) {
  return geminiRequest({
    system: `${judgeSystem(context)}\n\nBewerte jedes der folgenden Inserate unabhängig voneinander. Antworte mit einem score je ID.`,
    user: sample.map((x) => `ID ${x.id}\n${describe(x.listing)}`).join("\n\n"),
    schema: BACKTEST_SCHEMA,
    thinkingLevel: "medium",
    maxOutputTokens: 32768,
  });
}

/** Backtest answer → { n, mae, hitRateWithin1 } against the family's mean score. */
export function readBacktest(body, sample) {
  const scores = new Map(readJson(body).scores.map((s) => [s.id, s.score]));
  const diffs = sample.filter((x) => scores.has(x.id)).map((x) => Math.abs(scores.get(x.id) - x.combined));
  if (!diffs.length) return { n: 0, mae: null, hitRateWithin1: null };
  return {
    n: diffs.length,
    mae: diffs.reduce((a, b) => a + b, 0) / diffs.length,
    hitRateWithin1: diffs.filter((d) => d <= 1).length / diffs.length,
  };
}

/** Adopt only on a strictly lower MAE on the same sample (spec §6.3). */
export function decide(current, candidate) {
  if (!candidate || candidate.n === 0 || candidate.mae == null) return { adopt: false, reason: "Kandidat ohne Backtest-Ergebnis" };
  if (!current || current.mae == null) return { adopt: true, reason: "kein Vergleichswert" };
  return candidate.mae < current.mae
    ? { adopt: true, reason: `MAE ${candidate.mae.toFixed(2)} < ${current.mae.toFixed(2)}` }
    : { adopt: false, reason: `MAE ${candidate.mae.toFixed(2)} ≥ ${current.mae.toFixed(2)}` };
}

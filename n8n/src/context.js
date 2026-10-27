// Loads what every run needs once: config/criteria, the latest profile and its few-shot examples.
import { docId, fromFields } from "./firestore.js";

const RATERS = ["philipp", "manuela"];

/** documents:batchGet body for criteria + few-shot listings + both raters' ratings. */
export function contextBatchGet(projectId, profile) {
  const base = `projects/${projectId}/databases/(default)/documents`;
  const ids = profile?.fewShot ?? [];
  return {
    documents: [
      `${base}/config/criteria`,
      ...ids.map((id) => `${base}/listings/${id}`),
      ...ids.flatMap((id) => RATERS.map((r) => `${base}/ratings/${id}_${r}`)),
    ],
  };
}

/**
 * batchGet response (array of { found } | { missing }) → { criteria, examples }.
 * An example's score is the mean of both ratings (spec §6.3 "Uneinigkeit").
 */
export function readContext(batchBody, profile) {
  const found = (Array.isArray(batchBody) ? batchBody : [])
    .filter((r) => r.found)
    .map((r) => ({ path: r.found.name, id: docId(r.found.name), data: fromFields(r.found.fields) }));
  const criteria = found.find((d) => d.path.endsWith("/config/criteria"))?.data ?? {};
  const examples = (profile?.fewShot ?? [])
    .map((id) => {
      const listing = found.find((d) => d.path.endsWith(`/listings/${id}`))?.data;
      const ratings = RATERS.map((r) => found.find((d) => d.path.endsWith(`/ratings/${id}_${r}`))?.data)
        .filter((r) => r && r.score != null);
      if (!listing || !ratings.length) return null;
      const score = Math.round((ratings.reduce((a, r) => a + r.score, 0) / ratings.length) * 2) / 2;
      return {
        listing,
        score,
        tags: [...new Set(ratings.flatMap((r) => r.tags ?? []))],
        notes: ratings.map((r) => r.note).filter(Boolean),
      };
    })
    .filter(Boolean);
  return { criteria, examples };
}

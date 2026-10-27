// Final Firestore document for listings/{id} (spec §5.4). Fields starting with "_" are
// working data of the workflow and are not stored.
import { toFields } from "./firestore.js";

export function listingDoc(l, extra, now = new Date()) {
  const keep = Object.fromEntries(Object.entries(l).filter(([k]) => !k.startsWith("_") && k !== "id"));
  const doc = {
    ...keep,
    duplicateOf: l.duplicateOf ?? null,
    lat: null,
    lng: null,
    commute: null,
    prediction: null,
    status: l.duplicateOf ? "archived" : "new",
    reviewWeek: null,
    firstSeenAt: now.toISOString(),
    lastSeenAt: now.toISOString(),
    ...extra,
  };
  return { id: l.id, fields: toFields(doc), doc };
}

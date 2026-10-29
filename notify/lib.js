// Pure helpers for index.js (tested in lib.test.js).

/** Firestore CloudEvent subject "documents/batches/2026-W46" → { collection, id }. */
function parseSubject(subject) {
  const m = /^documents\/([^/]+)\/([^/]+)$/.exec(subject ?? "");
  return m ? { collection: m[1], id: m[2] } : null;
}

/** Notification for a new weekly batch. */
function batchPayload(week, batch) {
  const n = (batch.listingIds ?? []).length;
  const kw = /-W(\d+)$/.exec(week)?.[1];
  return {
    title: "Neue Inserate zum Bewerten",
    body: n
      ? `${n} ${n === 1 ? "Inserat wartet" : "Inserate warten"} auf eure Bewertung${kw ? ` (KW ${Number(kw)})` : ""}.`
      : `Der Stapel für ${week} ist da.`,
    url: "/",
    tag: `batch-${week}`,
  };
}

/** Confirmation right after a device turned notifications on. */
function welcomePayload(rater) {
  const name = { philipp: "Philipp", manuela: "Manuela" }[rater] ?? "";
  return {
    title: "Mitteilungen sind an",
    body: `${name ? `${name}, du` : "Du"} bekommst ab jetzt Bescheid, wenn neue Inserate in der App sind.`,
    url: "/",
    tag: "welcome",
  };
}

/** Push services answer 404/410 when a subscription is gone for good. */
function isGone(err) {
  return err && (err.statusCode === 404 || err.statusCode === 410);
}

module.exports = { parseSubject, batchPayload, welcomePayload, isGone };

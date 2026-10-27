// School run to the DSL (spec §5.3 node 7) from TfL Journey Planner responses.
// TfL plans walking and public transport; it does not plan car journeys, so driveMin stays empty.

/** Shortest journey in a JourneyResults response, or null (TfL error, disambiguation, no route). */
export function fastest(body) {
  const js = body && Array.isArray(body.journeys) ? body.journeys : [];
  return js.reduce((best, j) => (best == null || j.duration < best.duration ? j : best), null);
}

const MODE_DE = {
  bus: "Bus",
  tube: "U-Bahn",
  overground: "Overground",
  "national-rail": "Bahn",
  "elizabeth-line": "Elizabeth Line",
  dlr: "DLR",
  tram: "Tram",
};

/** "Bus 65", "Bus 371 und Bahn" – the non-walking legs in order, without repeats. */
export function transitSummary(journey) {
  if (!journey) return null;
  const parts = [];
  for (const leg of journey.legs ?? []) {
    const mode = leg.mode?.id ?? leg.mode?.name;
    if (!mode || mode === "walking" || mode === "cycle") continue;
    const label = MODE_DE[mode] ?? mode;
    const route = leg.routeOptions?.[0]?.name;
    const text = mode === "bus" && route ? `${label} ${route}` : label;
    if (!parts.includes(text)) parts.push(text);
  }
  return parts.length ? parts.join(" und ") : null;
}

/** Combines both TfL answers into the commute map of spec §5.4. */
export function commute(walkBody, transitBody, now = new Date()) {
  const walk = fastest(walkBody);
  const transit = fastest(transitBody);
  const summary = transitSummary(transit);
  return {
    walkMin: walk?.duration ?? null,
    // A "transit" journey that is all walking is not a transit option.
    transitMin: summary ? transit.duration : null,
    transitSummary: summary,
    driveMin: null,
    computedAt: now.toISOString(),
  };
}

/** Flag when even the best option exceeds the confirmed maximum (spec §8 point 3). */
export function commuteFlags(c, criteria = {}) {
  if (!c || criteria.maxCommuteMin == null) return [];
  const best = [c.walkMin, c.transitMin, c.driveMin].filter((x) => x != null);
  return best.length && Math.min(...best) > criteria.maxCommuteMin ? ["too_far"] : [];
}

/** postcodes.io answer → { lat, lng, approx } (approx = district centroid only). */
export function geocode(body) {
  const r = body?.result;
  if (!r || r.latitude == null) return null;
  return { lat: r.latitude, lng: r.longitude, approx: !r.postcode };
}

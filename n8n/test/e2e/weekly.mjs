// End-to-end run of london-weekly in a real n8n against mock-server.mjs (see harness.mjs).
//   N8N_BIN=/path/to/node_modules/n8n/bin/n8n node test/e2e/weekly.mjs
// Runs the workflow twice: the second run in the same week must not build a second batch.
import assert from "node:assert/strict";
import { loadWorkflow, n8nHome, replaceWithProbe, startManually } from "./harness.mjs";
import { startMock } from "./mock-server.mjs";
import { isoWeek, reviewWeek } from "../../src/weekly.js";

const now = new Date();
const weekAgo = (n) => isoWeek(new Date(now.getTime() - n * 7 * 86400000));
const thisWeek = weekAgo(0);
const nextWeek = reviewWeek(now);

const seed = {
  "config/criteria": { phase: "calibrate" },
  "profiles/1": { version: 1, rules: ["Alte Regel"], fewShot: ["r0"], basedOnRatings: 10, hardFilters: { minBeds: 3 } },
  // Three earlier weeks at target; this week's batch decides the fourth.
  [`batches/${weekAgo(3)}`]: { week: weekAgo(3), listingIds: [], metrics: { philipp: { n: 10, mae: 0.5, hitRateWithin1: 0.9 } } },
  [`batches/${weekAgo(2)}`]: { week: weekAgo(2), listingIds: [], metrics: { philipp: { n: 10, mae: 0.5, hitRateWithin1: 0.9 } } },
  [`batches/${weekAgo(1)}`]: { week: weekAgo(1), listingIds: [], metrics: { philipp: { n: 8, mae: 0.4, hitRateWithin1: 1 } } },
  [`batches/${thisWeek}`]: { week: thisWeek, listingIds: ["r0", "r1", "r2", "r3", "r4", "r5", "unseen"], completed: {} },
};
const listing = (id, extra) => ({
  address: `${id} Road`, postcode: "TW10 7", area: "Ham", priceMonthly: 5000, letType: "short_let", furnished: "furnished",
  beds: 3, flags: [], firstSeenAt: now.toISOString(), ...extra,
});
// 20 rated listings (r0–r5 in this week's batch), both raters agree, prediction within ±1.
for (let i = 0; i < 20; i++) {
  const score = (i % 5) + 1;
  seed[`listings/r${i}`] = listing(`r${i}`, { status: i < 6 ? "queued" : "reviewed", prediction: { score } });
  for (const rater of ["philipp", "manuela"]) {
    seed[`ratings/r${i}_${rater}`] = { listingId: `r${i}`, rater, score, tags: [], note: "", predictionAtRating: score, createdAt: new Date(now.getTime() - (20 - i) * 3600000).toISOString() };
  }
}
seed["listings/unseen"] = listing("unseen", { status: "queued", prediction: { score: 3 } });
// 14 unrated candidates, one of them a duplicate, one far away and expensive.
for (let i = 0; i < 14; i++) seed[`listings/c${i}`] = listing(`c${i}`, { status: "new", prediction: { score: (i % 5) + 1 } });
seed["listings/c13"] = listing("c13", { status: "new", postcode: "SW19 4", priceMonthly: 9500, prediction: { score: 2 } });
seed["listings/dup"] = listing("dup", { status: "new", duplicateOf: "c0", prediction: { score: 5 } });

const mock = await startMock(seed);
const wf = loadWorkflow("london-weekly.json", mock.url);
replaceWithProbe(wf, "Notify review ready", mock.url, "/notify");
startManually(wf, "Settings", { removeTrigger: "Every Sunday 18:00" });
const run = n8nHome();

try {
  await run(wf, "LondonWeeklyE2E1");

  // 1 · New batch for next week: 12 listings, mix 6/4/2, no duplicate, all queued
  const batch = mock.doc(`batches/${nextWeek}`);
  assert.ok(batch, `batch ${nextWeek} written`);
  assert.equal(batch.listingIds.length, 12);
  assert.deepEqual(batch.mix, { top: 6, unsure: 4, atypical: 2 });
  assert.ok(!batch.listingIds.includes("dup"));
  for (const id of batch.listingIds) {
    assert.equal(mock.doc(`listings/${id}`).status, "queued");
    assert.equal(mock.doc(`listings/${id}`).reviewWeek, nextWeek);
  }
  assert.ok(batch.listingIds.includes("c13"), "far/expensive listing picked as atypical");
  // Unseen listing from this week went back to the pool (new, or queued again if picked)
  assert.ok(["new", "queued"].includes(mock.doc("listings/unseen").status));

  // This week's batch settled with metrics
  const prev = mock.doc(`batches/${thisWeek}`);
  assert.deepEqual(prev.metrics.philipp, { n: 6, mae: 0, hitRateWithin1: 1 });
  assert.equal(prev.metrics.agreement, 1);
  assert.equal(mock.doc("listings/r0").status, "reviewed");

  // Phase check: four weeks in a row ≥ 80 %
  assert.deepEqual({ ...mock.doc("config/status"), updatedAt: undefined }, { weeksAtTarget: 4, readyForHunt: true, lastBatch: nextWeek, updatedAt: undefined });

  // 2 · Notification with the summary
  const notes = mock.calls.filter((c) => c.path === "/notify");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].body.week, nextWeek);
  assert.equal(notes[0].body.phase.readyForHunt, true);

  // 3 · Profile: candidate beats the old one in the backtest and is stored as v2
  const p2 = mock.doc("profiles/2");
  assert.ok(p2, "profile v2 written");
  assert.deepEqual(p2.rules, ["MOCK-REGEL"]);
  assert.deepEqual(p2.hardFilters, { minBeds: 3 }, "confirmed hard filters kept");
  assert.equal(p2.suggestedHardFilters.maxPriceMonthly, 7000);
  assert.equal(p2.basedOnRatings, 20);
  assert.equal(p2.metrics.mae, 0);
  const backtests = mock.calls.filter((c) => c.path === "/anthropic/v1/messages" && c.body.output_config.format.schema.properties.scores);
  assert.equal(backtests.length, 2);
  for (const b of backtests) assert.ok(!/^ID (r0|r1|r2|r3|r4|r5)$/m.test(b.body.messages[0].content), "few-shot ids excluded from backtest");

  // Second run in the same week: nothing new
  const callsBefore = mock.calls.length;
  await run(wf, "LondonWeeklyE2E2");
  assert.deepEqual(mock.doc(`batches/${nextWeek}`).listingIds, batch.listingIds);
  assert.equal(mock.doc("profiles/3"), null);
  assert.equal(mock.calls.slice(callsBefore).filter((c) => c.path === "/notify" || c.path.startsWith("/anthropic")).length, 0);

  console.log(`e2e ok – batch ${nextWeek} with ${batch.listingIds.length} listings, profile v2 adopted`);
} finally {
  mock.close();
}

// End-to-end run of london-ingest in a real n8n against mock-server.mjs (see harness.mjs).
//   N8N_BIN=/path/to/node_modules/n8n/bin/n8n node test/e2e/ingest.mjs
// The fixture mails sit in a mock AgentMail inbox; the schedule trigger is replaced by a manual start.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { loadWorkflow, n8nHome, replaceWithProbe, startManually } from "./harness.mjs";
import { startMock } from "./mock-server.mjs";
import { fingerprint } from "../../src/normalize.js";

const fixture = (n) => readFileSync(new URL(`../fixtures/${n}.html`, import.meta.url), "utf8");

// Same house as the first OnTheMarket listing (Kings Road, KT2, 5 beds), on OpenRent in the same run.
const kingsRoadOpenRent = `<p><a href="https://www.openrent.co.uk/property-to-rent/kingston/5-bed-house/3456789">
  <img src="https://imagescdn.openrent.co.uk/k.jpg"></a></p><p>&pound;4,250 per month</p><p>5 Bed House</p><p>Kings Road, Kingston, KT2</p>`;

const mails = [
  ["zoopla", "Zoopla <alerts@email.zoopla.co.uk>"],
  ["rightmove", "noreply@rightmove.co.uk"],
  ["openrent", "OpenRent <notifications@openrent.co.uk>"],
  ["agency", "Example Lettings <news@example-lettings.co.uk>"],
  ["onthemarket", "OnTheMarket Property Alerts <property-alerts@mail.onthemarket.com>"],
  ["kingsroad", "OpenRent <notifications@openrent.co.uk>", kingsRoadOpenRent],
  // Gemini fails on this newsletter: the mail must stay unlabelled for the next poll.
  ["failing", "Other Lettings <news@other-lettings.co.uk>", "<p>MOCK-FAIL newsletter</p>"],
].map(([n, from, html], i) => ({
  inbox_id: "london@agentmail.to", message_id: `<msg-${n}@mail>`, thread_id: `t-${n}`, labels: ["received"],
  timestamp: `2026-11-08T0${i}:00:00Z`, from, to: ["london@agentmail.to"], subject: `Alert ${n}`, html: html ?? fixture(n), size: 1,
}));
// Already handled in an earlier run: must be skipped.
mails.push({ ...mails[0], message_id: "<old@mail>", labels: ["received", "london-processed"] });

const mock = await startMock({
  "config/criteria": { maxPriceMonthly: 7000, minBeds: 3, maxCommuteMin: 30, phase: "hunt" },
  "profiles/1": { version: 1, rules: ["Garten ist wichtig"], fewShot: ["zoopla-1"] },
  "listings/zoopla-1": { address: "Example Road", beds: 3, priceMonthly: 5000, letType: "short_let", furnished: "furnished", flags: [] },
  "ratings/zoopla-1_philipp": { score: 4, tags: ["Lage"], note: "nah" },
  // Already known: should only get lastSeenAt.
  "listings/rightmove-90123456": { address: "Upper Richmond Road West, East Sheen, SW14 8DS", lastSeenAt: "2026-01-01T00:00:00Z", beds: 3 },
  // Same house as the Rightmove Compton Road listing, seen earlier on OpenRent.
  "listings/openrent-1111111": { address: "Compton Road, Wimbledon", beds: 5, fingerprint: fingerprint("Compton Road, Wimbledon, SW19", "SW19", 5), commute: { walkMin: 90 } },
  // Saved earlier while Gemini was failing: gets its prediction now.
  "listings/zoopla-5555555": {
    address: "Ham Street, Ham", postcode: "TW10 7", beds: 4, priceMonthly: 5200, letType: "unknown", furnished: "unknown", flags: [],
    commute: { walkMin: 12, transitMin: 10, transitSummary: "Bus 65" }, status: "new", prediction: null, predictionError: "Gemini API error: credits depleted",
  },
  // Same street, district and bedrooms as the Zoopla Forge Lane listing, but a very different rent: not a duplicate.
  "listings/rightmove-7777777": { address: "Forge Lane, Petersham", beds: 3, priceMonthly: 9500, fingerprint: fingerprint("Forge Lane, Petersham", "TW10", 3) },
}, { mails });

const wf = loadWorkflow("london-ingest.json", mock.url);
replaceWithProbe(wf, "Notify (channel open)", mock.url, "/notify");
startManually(wf, "Settings", { removeTrigger: "Every 3 hours" });
const run = n8nHome();

try {
  const out = await run(wf, "LondonIngestE2E");

  if (process.env.E2E_DEBUG) console.log(mock.calls.map((c) => `${c.method} ${c.path}`).join("\n"), out.slice(-6000));
  const l = (id) => mock.doc(`listings/${id}`);
  // Parser path (Zoopla)
  assert.equal(l("zoopla-73843699").priceMonthly, 4080);
  assert.equal(l("zoopla-73843699").extractedBy, "parser");
  assert.deepEqual(l("zoopla-73843699").commute.transitSummary, "Bus 65");
  assert.equal(l("zoopla-73843699").prediction.score, 4);
  assert.equal(l("zoopla-74426560").priceMonthly, 6864);
  assert.deepEqual(l("zoopla-74426560").flags, ["term_too_short"]);
  // Gemini fallback (agency newsletter)
  const agency = mock.paths().find((p) => p.startsWith("listings/agency-"));
  assert.ok(agency, "agency listing saved");
  assert.equal(mock.doc(agency).extractedBy, "gemini");
  assert.equal(mock.doc(agency).priceMonthly, 6283);
  // Duplicate across portals
  assert.equal(l("rightmove-90814923").duplicateOf, "openrent-1111111");
  assert.equal(l("rightmove-90814923").status, "archived");
  assert.equal(l("rightmove-90814923").prediction, null);
  // Known listing only touched
  assert.notEqual(l("rightmove-90123456").lastSeenAt, "2026-01-01T00:00:00Z");
  assert.equal(l("rightmove-90123456").prediction, undefined);
  // OpenRent
  assert.equal(l("openrent-2345678").availableFrom, "2028-01-01");
  // Prediction prompt carried profile and few-shot example; the model from Settings is in the URL
  const geminiCalls = mock.calls.filter((c) => c.path.startsWith("/gemini/"));
  assert.ok(geminiCalls.every((c) => c.path === "/gemini/v1beta/models/gemini-3.8-flash:generateContent"), "model from Settings");
  const isExtraction = (c) => !!c.body.generationConfig.responseJsonSchema.properties.listings;
  const predict = geminiCalls.find((c) => !isExtraction(c));
  assert.match(predict.body.systemInstruction.parts[0].text, /Garten ist wichtig/);
  assert.match(predict.body.systemInstruction.parts[0].text, /Beispiel 1 – Bewertung 4/);
  assert.equal(predict.body.generationConfig.responseMimeType, "application/json");
  // Gemini extraction only for the two agency newsletters (one of them fails)
  assert.equal(geminiCalls.filter(isExtraction).length, 2);
  // OnTheMarket read by the parser, no Gemini extraction for it
  assert.equal(l("onthemarket-21000001").extractedBy, "parser");
  assert.equal(l("onthemarket-21000001").priceMonthly, 4200);
  assert.equal(l("onthemarket-21000002").postcode, "SW19");
  // Same house on two portals in one run: the later one is archived as duplicate
  assert.equal(l("openrent-3456789").duplicateOf, "onthemarket-21000001");
  assert.equal(l("openrent-3456789").status, "archived");
  // Same street but rent far apart: a new listing, not a duplicate
  assert.equal(l("zoopla-73843699").duplicateOf, null);
  // Listing saved earlier without prediction: scored now, error cleared, nothing else touched
  assert.equal(l("zoopla-5555555").prediction.score, 4);
  assert.equal(l("zoopla-5555555").predictionError, null);
  assert.equal(l("zoopla-5555555").address, "Ham Street, Ham");
  // Hunt phase: every new, non-duplicate listing with score ≥ 4 is announced (mock scores 4)
  const notified = mock.calls.filter((c) => c.path === "/notify").map((c) => c.body.name.split("/").pop()).sort();
  assert.deepEqual(notified, [agency.split("/")[1], "openrent-2345678", "zoopla-73843699", "zoopla-74426560", "onthemarket-21000001", "onthemarket-21000002"].sort());

  // Mails: the old one skipped, each new one fetched once and labelled after the last save,
  // except the one Gemini could not read
  const labelled = mock.calls.filter((c) => c.method === "PATCH" && c.path.startsWith("/agentmail/"));
  assert.deepEqual(labelled.map((c) => c.path.split("/").pop()).sort(), mails.slice(0, 6).map((m) => m.message_id).sort());
  assert.ok(!mails[6].labels.includes("london-processed"), "failed mail stays unlabelled");
  assert.ok(!mock.calls.some((c) => c.path.endsWith("<old@mail>")), "processed mail not fetched");
  // (the rescore branch patches only prediction fields and runs last, after the labels)
  const isRescore = (c) => (c.query["updateMask.fieldPaths"] ?? "").startsWith("prediction");
  const listingPatches = mock.calls.filter((c) => c.method === "PATCH" && c.path.includes("/documents/listings/"));
  const lastSave = mock.calls.lastIndexOf(listingPatches.filter((c) => !isRescore(c)).at(-1));
  assert.ok(mock.calls.indexOf(labelled[0]) > lastSave, "mails labelled only after all listings were saved");
  assert.ok(listingPatches.filter(isRescore).every((c) => mock.calls.indexOf(c) > mock.calls.indexOf(labelled.at(-1))), "rescore runs last");

  // Second poll: nothing new (the failing mail is set aside for this check), so no Firestore or Gemini traffic
  mails[6].labels.push("london-processed");
  const before = mock.calls.length;
  await run(wf, "LondonIngestE2E2");
  const later = mock.calls.slice(before).map((c) => c.path);
  assert.ok(later.length >= 1 && later.every((p) => p.startsWith("/agentmail/")), `second poll only lists mails: ${later.join(", ")}`);

  console.log(`e2e ok – ${mock.paths().filter((p) => p.startsWith("listings/")).length} listings in mock Firestore, ${mock.calls.length} API calls`);
} finally {
  mock.close();
}

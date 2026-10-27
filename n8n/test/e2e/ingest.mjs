// End-to-end run of london-ingest in a real n8n against mock-server.mjs (see harness.mjs).
//   N8N_BIN=/path/to/node_modules/n8n/bin/n8n node test/e2e/ingest.mjs
// The Gmail trigger is replaced by the fixture mails.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { loadWorkflow, n8nHome, replaceWithCode, replaceWithProbe, startManually } from "./harness.mjs";
import { startMock } from "./mock-server.mjs";
import { fingerprint } from "../../src/normalize.js";

const fixture = (n) => readFileSync(new URL(`../fixtures/${n}.html`, import.meta.url), "utf8");

const mock = await startMock({
  "config/criteria": { maxPriceMonthly: 7000, minBeds: 3, maxCommuteMin: 30, phase: "hunt" },
  "profiles/1": { version: 1, rules: ["Garten ist wichtig"], fewShot: ["zoopla-1"] },
  "listings/zoopla-1": { address: "Example Road", beds: 3, priceMonthly: 5000, letType: "short_let", furnished: "furnished", flags: [] },
  "ratings/zoopla-1_philipp": { score: 4, tags: ["Lage"], note: "nah" },
  // Already known: should only get lastSeenAt.
  "listings/rightmove-90123456": { address: "Upper Richmond Road West, East Sheen, SW14 8DS", lastSeenAt: "2026-01-01T00:00:00Z", beds: 3 },
  // Same house as the Rightmove Compton Road listing, seen earlier on OpenRent.
  "listings/openrent-1111111": { address: "Compton Road, Wimbledon", beds: 5, fingerprint: fingerprint("Compton Road, Wimbledon, SW19", "SW19", 5), commute: { walkMin: 90 } },
});

const mails = [
  ["zoopla", "alerts@email.zoopla.co.uk"],
  ["rightmove", "noreply@rightmove.co.uk"],
  ["openrent", "notifications@openrent.co.uk"],
  ["agency", "news@example-lettings.co.uk"],
].map(([n, from], i) => ({ id: `msg-${n}`, from: { value: [{ address: from }] }, subject: `Alert ${n}`, date: "2026-11-08", html: fixture(n), i }));

const wf = loadWorkflow("london-ingest.json", mock.url);
replaceWithCode(wf, "Gmail Trigger", `return ${JSON.stringify(mails)}.map((json) => ({ json }));`);
replaceWithProbe(wf, "Notify (channel open)", mock.url, "/notify");
startManually(wf, "Gmail Trigger");
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
  // Claude fallback (agency newsletter)
  const agency = mock.paths().find((p) => p.startsWith("listings/agency-"));
  assert.ok(agency, "agency listing saved");
  assert.equal(mock.doc(agency).extractedBy, "claude");
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
  // Prediction prompt carried profile and few-shot example; Claude headers were sent
  const predict = mock.calls.find((c) => c.path === "/anthropic/v1/messages" && !c.body.output_config.format.schema.properties.listings);
  assert.match(predict.body.system, /Garten ist wichtig/);
  assert.match(predict.body.system, /Beispiel 1 – Bewertung 4/);
  assert.equal(predict.headers["anthropic-version"], "2026-10-21");
  // Exactly one Claude extraction (only the agency mail needed it)
  assert.equal(mock.calls.filter((c) => c.path === "/anthropic/v1/messages" && c.body.output_config.format.schema.properties.listings).length, 1);
  // Hunt phase: every new, non-duplicate listing with score ≥ 4 is announced (mock scores 4)
  const notified = mock.calls.filter((c) => c.path === "/notify").map((c) => c.body.name.split("/").pop()).sort();
  assert.deepEqual(notified, [agency.split("/")[1], "openrent-2345678", "zoopla-73843699", "zoopla-74426560"].sort());

  console.log(`e2e ok – ${mock.paths().filter((p) => p.startsWith("listings/")).length} listings in mock Firestore, ${mock.calls.length} API calls`);
} finally {
  mock.close();
}

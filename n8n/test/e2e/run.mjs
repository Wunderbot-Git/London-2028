// End-to-end run of london-ingest in a real n8n against mock-server.mjs.
//   N8N_BIN=/path/to/node_modules/n8n/bin/n8n node test/e2e/run.mjs
// Needs n8n installed separately (Node 24+); not part of `npm test`.
// The Gmail trigger is replaced by the fixture mails, all API hosts point at the mock, and
// credentials are dropped. Everything else – nodes, expressions, Code – runs as built.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { startMock } from "./mock-server.mjs";
import { fingerprint } from "../../src/normalize.js";

const n8n = process.env.N8N_BIN;
if (!n8n) throw new Error("Set N8N_BIN to n8n's bin/n8n");
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

let text = readFileSync(new URL("../../london-ingest.json", import.meta.url), "utf8")
  .replaceAll("https://firestore.googleapis.com", `${mock.url}/firestore`)
  .replaceAll("https://api.anthropic.com", `${mock.url}/anthropic`)
  .replaceAll("https://api.tfl.gov.uk", `${mock.url}/tfl`)
  .replaceAll("https://api.postcodes.io", `${mock.url}/postcodes`)
  .replace("DEIN-GCP-PROJEKT", "test");
const wf = JSON.parse(text);
wf.id = "LondonIngestE2E";
wf.active = false;
for (const n of wf.nodes) {
  delete n.credentials;
  if (n.type === "n8n-nodes-base.httpRequest") {
    delete n.parameters.authentication;
    delete n.parameters.nodeCredentialType;
    delete n.parameters.genericAuthType;
  }
}
const gmail = wf.nodes.find((n) => n.name === "Gmail Trigger");
Object.assign(gmail, {
  type: "n8n-nodes-base.code",
  typeVersion: 2,
  parameters: { jsCode: `return ${JSON.stringify(mails)}.map((json) => ({ json }));` },
});
// The notification placeholder becomes a call to the mock so the test can see who got through.
Object.assign(wf.nodes.find((n) => n.name === "Notify (channel open)"), {
  type: "n8n-nodes-base.httpRequest",
  typeVersion: 4.2,
  parameters: { method: "POST", url: `${mock.url}/notify`, sendBody: true, specifyBody: "json", jsonBody: "={{ JSON.stringify({ name: $json.name }) }}", options: {} },
});
wf.nodes.push({ id: "start", name: "Start", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [-220, 0], parameters: {} });
wf.connections.Start = { main: [[{ node: "Gmail Trigger", type: "main", index: 0 }]] };

const home = mkdtempSync(join(tmpdir(), "n8n-e2e-"));
const file = join(home, "wf.json");
writeFileSync(file, JSON.stringify(wf));
const env = { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", N8N_USER_FOLDER: home, N8N_RUNNERS_ENABLED: "true", N8N_DIAGNOSTICS_ENABLED: "false", DB_SQLITE_POOL_SIZE: "1" };
// Async on purpose: the mock server lives in this process and must keep answering.
const run = async (...args) => {
  try {
    return (await promisify(execFile)(process.execPath, [n8n, ...args], { env, maxBuffer: 1 << 28 })).stdout;
  } catch (e) {
    console.error(`n8n ${args[0]} failed:\n${e.stdout?.slice(-3000)}\n${e.stderr?.slice(-3000)}`);
    throw new Error(`n8n ${args[0]} failed`);
  }
};

try {
  await run("import:workflow", `--input=${file}`);
  const out = await run("execute", "--id=LondonIngestE2E", "--rawOutput");

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

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseSubject, batchPayload, welcomePayload, isGone } = require("./lib");

test("parses the document path from the event subject", () => {
  assert.deepEqual(parseSubject("documents/batches/2026-W46"), { collection: "batches", id: "2026-W46" });
  assert.deepEqual(parseSubject("documents/pushSubscriptions/philipp_ab12"), { collection: "pushSubscriptions", id: "philipp_ab12" });
  assert.equal(parseSubject("documents/batches/2026-W46/x/y"), null);
  assert.equal(parseSubject(undefined), null);
});

test("batch notification names count and calendar week", () => {
  const p = batchPayload("2026-W46", { listingIds: Array(12).fill("x") });
  assert.equal(p.title, "Neue Inserate zum Bewerten");
  assert.equal(p.body, "12 Inserate warten auf eure Bewertung (KW 46).");
  assert.equal(p.tag, "batch-2026-W46");
  assert.equal(batchPayload("2026-W02", { listingIds: ["x"] }).body, "1 Inserat wartet auf eure Bewertung (KW 2).");
  assert.equal(batchPayload("2026-W46", {}).body, "Der Stapel für 2026-W46 ist da.");
});

test("welcome and expired subscriptions", () => {
  assert.match(welcomePayload("manuela").body, /^Manuela, du bekommst/);
  assert.ok(isGone({ statusCode: 410 }));
  assert.ok(!isGone({ statusCode: 500 }));
});

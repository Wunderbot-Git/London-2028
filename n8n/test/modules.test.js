import { describe, expect, it } from "vitest";
import { commute, commuteFlags, geocode, transitSummary } from "../src/commute.js";
import { contextBatchGet, readContext } from "../src/context.js";
import { equalityQuery, fromFields, queryDocs, toFields } from "../src/firestore.js";
import { describe as describeListing, extractionRequest, predictionRequest, readJson, readPrediction } from "../src/claude.js";
import { dateFromText, fingerprint, nextMonday, splitPostcode, termFromText } from "../src/normalize.js";

describe("normalize helpers", () => {
  it("parses terms and dates", () => {
    expect(termFromText("Short let, 2-5 months")).toEqual({ min: 2, max: 5 });
    expect(termFromText("Minimum tenancy: 6 months")).toEqual({ min: 6, max: null });
    expect(dateFromText("1st January 2028")).toBe("2028-01-01");
    expect(dateFromText("01/02/28")).toBe("2028-02-01");
    expect(dateFromText("Jan 2028")).toBe("2028-01-01");
    expect(dateFromText("soonish")).toBeNull();
  });
  it("splits postcodes", () => {
    expect(splitPostcode("tw10 7ah")).toEqual({ full: "TW10 7AH", district: "TW10", sector: "TW10 7" });
    expect(splitPostcode("SW14")).toEqual({ full: null, district: "SW14", sector: "SW14" });
    expect(splitPostcode("nonsense")).toEqual({ full: null, district: null, sector: null });
  });
  it("matches the same house across portals", () => {
    expect(fingerprint("Flat 2, Forge Lane, Petersham, TW10 7AB", "TW10", 3)).toBe(fingerprint("Forge Lane, Petersham", "TW10", 3));
    expect(fingerprint("Petersham Road", "TW10", 3)).toBe(fingerprint("Petersham Rd", "TW10", 3));
  });
  it("plans for the next Monday", () => {
    expect(nextMonday(new Date("2026-11-08T10:00:00Z"))).toBe("20261109"); // Sunday
    expect(nextMonday(new Date("2026-11-09T10:00:00Z"))).toBe("20261116"); // Monday → next week
  });
});

describe("firestore encoding", () => {
  it("round-trips the listing shape", () => {
    const doc = { a: 1, b: 1.5, c: "x", d: null, e: [1, "y"], f: { g: true }, lastSeenAt: "2026-11-08T10:00:00.000Z", h: [] };
    const fields = toFields(doc);
    expect(fields.lastSeenAt).toEqual({ timestampValue: "2026-11-08T10:00:00.000Z" });
    expect(fields.a).toEqual({ integerValue: "1" });
    expect(fromFields(fields)).toEqual(doc);
  });
  it("builds and reads queries", () => {
    expect(equalityQuery("listings", "fingerprint", "x|tw10|3").structuredQuery.where.fieldFilter.value).toEqual({ stringValue: "x|tw10|3" });
    const body = [{ readTime: "t" }, { document: { name: "projects/p/databases/(default)/documents/listings/zoopla-1", fields: { beds: { integerValue: "3" } } } }];
    expect(queryDocs(body)).toEqual([{ id: "zoopla-1", beds: 3 }]);
    expect(queryDocs({ error: {} })).toEqual([]);
  });
});

describe("commute", () => {
  const leg = (mode, route) => ({ mode: { id: mode }, routeOptions: route ? [{ name: route }] : [] });
  it("takes the fastest journeys and names the buses", () => {
    const walk = { journeys: [{ duration: 24, legs: [leg("walking")] }, { duration: 22, legs: [leg("walking")] }] };
    const transit = { journeys: [{ duration: 12, legs: [leg("walking"), leg("bus", "65"), leg("walking")] }, { duration: 15, legs: [leg("bus", "371")] }] };
    const c = commute(walk, transit, new Date("2026-11-08T10:00:00Z"));
    expect(c).toEqual({ walkMin: 22, transitMin: 12, transitSummary: "Bus 65", driveMin: null, computedAt: "2026-11-08T10:00:00.000Z" });
  });
  it("copes with TfL errors and walking-only transit answers", () => {
    expect(commute({ httpStatusCode: 500 }, { journeys: [{ duration: 30, legs: [leg("walking")] }] })).toMatchObject({ walkMin: null, transitMin: null, transitSummary: null });
    expect(transitSummary({ legs: [leg("bus", "65"), leg("national-rail"), leg("bus", "65")] })).toBe("Bus 65 und Bahn");
  });
  it("flags long school runs only against a confirmed maximum", () => {
    expect(commuteFlags({ walkMin: 50, transitMin: 35 }, { maxCommuteMin: 30 })).toEqual(["too_far"]);
    expect(commuteFlags({ walkMin: 50, transitMin: 25 }, { maxCommuteMin: 30 })).toEqual([]);
    expect(commuteFlags({ walkMin: 50 }, {})).toEqual([]);
  });
  it("reads postcodes.io", () => {
    expect(geocode({ result: { postcode: "TW10 7AH", latitude: 51.44, longitude: -0.3 } })).toEqual({ lat: 51.44, lng: -0.3, approx: false });
    expect(geocode({ result: { outcode: "TW10", latitude: 51.44, longitude: -0.3 } })).toEqual({ lat: 51.44, lng: -0.3, approx: true });
    expect(geocode({ status: 404 })).toBeNull();
  });
});

describe("context", () => {
  const profile = { version: 3, rules: ["Garten wichtiger als 4. Schlafzimmer"], fewShot: ["zoopla-1"] };
  it("asks for criteria, few-shot listings and both ratings", () => {
    const docs = contextBatchGet("p", profile).documents;
    expect(docs).toEqual([
      "projects/p/databases/(default)/documents/config/criteria",
      "projects/p/databases/(default)/documents/listings/zoopla-1",
      "projects/p/databases/(default)/documents/ratings/zoopla-1_philipp",
      "projects/p/databases/(default)/documents/ratings/zoopla-1_manuela",
    ]);
    expect(contextBatchGet("p", null).documents).toHaveLength(1);
  });
  it("averages the two ratings for an example", () => {
    const base = "projects/p/databases/(default)/documents";
    const f = (name, fields) => ({ found: { name: `${base}/${name}`, fields: toFields(fields) } });
    const body = [
      f("config/criteria", { minBeds: 3 }),
      f("listings/zoopla-1", { address: "Forge Lane", beds: 3 }),
      f("ratings/zoopla-1_philipp", { score: 5, tags: ["Lage"], note: "Top" }),
      f("ratings/zoopla-1_manuela", { score: 3, tags: ["Lage", "Laufzeit"], note: "" }),
    ];
    expect(readContext(body, profile)).toEqual({
      criteria: { minBeds: 3 },
      examples: [{ listing: { address: "Forge Lane", beds: 3 }, score: 4, tags: ["Lage", "Laufzeit"], notes: ["Top"] }],
    });
  });
});

describe("claude", () => {
  const settings = { claudeModel: "claude-opus-5-5" };
  const listing = {
    address: "Forge Lane", area: "Petersham", postcode: "TW10", priceMonthly: 4080, letType: "periodic",
    beds: 3, baths: 2, furnished: "either", garden: true, parking: true,
    commute: { walkMin: 5, transitMin: null }, flags: ["periodic_risk"],
  };

  it("builds an extraction request with a JSON schema", () => {
    const r = extractionRequest({ from: "a@b.c", subject: "S", text: "T" }, settings, new Date("2026-11-08T00:00:00Z"));
    expect(r.model).toBe("claude-opus-5-5");
    expect(r.output_config.format.type).toBe("json_schema");
    expect(r.messages[0].content).toContain("Today: 2026-11-08");
  });

  it("puts profile rules, guard rails and examples into the prediction prompt", () => {
    const r = predictionRequest(listing, {
      criteria: { maxPriceMonthly: 7000 },
      profile: { version: 2, rules: ["Garten zählt viel"], hardFilters: { minBeds: 3 } },
      examples: [{ listing, score: 4.5, tags: ["Lage"], notes: [] }],
    }, settings);
    expect(r.system).toContain("Budget bis £7000 pcm; mindestens 3 Schlafzimmer");
    expect(r.system).toContain("Gelernte Vorlieben (Profil v2)");
    expect(r.system).toContain("Beispiel 1 – Bewertung 4.5 (Gründe: Lage)");
    expect(r.messages[0].content).toContain("Schulweg zur DSL: 5 Min. zu Fuß");
    expect(describeListing(listing)).toContain("Garten: ja; Parkplatz: ja");
  });

  it("reads answers and refuses bad ones loudly", () => {
    const ok = { model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text: '{"score":4,"rationale":"Gut."}' }] };
    expect(readPrediction(ok, 2, new Date("2026-11-08T00:00:00Z"))).toEqual({
      score: 4, rationale: "Gut.", profileVersion: 2, model: "claude-opus-5-5", createdAt: "2026-11-08T00:00:00.000Z",
    });
    expect(() => readJson({ stop_reason: "refusal", content: [] })).toThrow(/declined/);
    expect(() => readJson({ type: "error", error: { message: "overloaded" } })).toThrow(/overloaded/);
    expect(() => readJson({ stop_reason: "max_tokens", content: [] })).toThrow(/max_tokens/);
  });
});

import { listingDoc } from "../src/doc.js";
describe("listingDoc", () => {
  it("drops working fields and sets defaults", () => {
    const now = new Date("2026-11-08T10:00:00Z");
    const { id, doc, fields } = listingDoc({ id: "zoopla-1", address: "A", _kind: "new", _geoUrl: "x", flags: [] }, { lat: 51.4 }, now);
    expect(id).toBe("zoopla-1");
    expect(doc).toEqual({
      address: "A", flags: [], duplicateOf: null, lat: 51.4, lng: null, commute: null, prediction: null,
      status: "new", reviewWeek: null, firstSeenAt: "2026-11-08T10:00:00.000Z", lastSeenAt: "2026-11-08T10:00:00.000Z",
    });
    expect(fields.firstSeenAt).toEqual({ timestampValue: "2026-11-08T10:00:00.000Z" });
    expect(listingDoc({ id: "b", duplicateOf: "a" }, {}, now).doc.status).toBe("archived");
  });
});

import { PROCESSED_LABEL, newMessageIds, toMail } from "../src/agentmail.js";
import { parseMail } from "../src/parse.js";
describe("agentmail", () => {
  it("lists unprocessed messages oldest first", () => {
    const body = { count: 3, messages: [
      { message_id: "b", timestamp: "2026-11-08T10:00:00Z", labels: ["received"] },
      { message_id: "a", timestamp: "2026-11-08T09:00:00Z", labels: ["received"] },
      { message_id: "c", timestamp: "2026-11-08T08:00:00Z", labels: ["received", PROCESSED_LABEL] },
    ] };
    expect(newMessageIds(body)).toEqual(["a", "b"]);
    expect(newMessageIds({})).toEqual([]);
  });
  it("feeds the parser with the sender string", () => {
    const mail = toMail({ message_id: "m1", from: "Zoopla <alerts@email.zoopla.co.uk>", subject: "New", timestamp: "2026-11-08T10:00:00Z", html: '<a href="https://www.zoopla.co.uk/to-rent/details/73843699/">£4,080 pcm</a> 3 bed, Forge Lane, Petersham' });
    const parsed = parseMail(mail);
    expect(parsed).toMatchObject({ messageId: "m1", source: "zoopla", from: "Zoopla <alerts@email.zoopla.co.uk>" });
    expect(parsed.listings[0]).toMatchObject({ sourceId: "73843699", price: 4080, beds: 3 });
    expect(sourceForSenderCheck("Lettings Ltd <news@example-lettings.co.uk>")).toBe("agency:example-lettings.co.uk");
  });
});
import { sourceForSender as sourceForSenderCheck } from "../src/parse.js";

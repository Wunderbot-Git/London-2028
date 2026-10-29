// Tests firestore.rules against the local emulator: npm test (in firestore/).
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import { assertFails, assertSucceeds, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { deleteDoc, doc, getDoc, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";

let env;
const P = "philipp@example.com";
const M = "manuela@example.com";
const db = (email, verified = true) =>
  env.authenticatedContext(email, { email, email_verified: verified }).firestore();

const rating = (rater, extra = {}) => ({
  listingId: "L1", rater, score: 4, tags: ["Lage"], note: "", predictionAtRating: 3,
  createdAt: serverTimestamp(), ...extra,
});

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-london-wohn-review",
    firestore: { rules: readFileSync(new URL("./firestore.rules", import.meta.url), "utf8"), host: "127.0.0.1", port: 8081 },
  });
});
afterAll(() => env.cleanup());
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const a = ctx.firestore();
    await setDoc(doc(a, "config/access"), { raters: { [P]: "philipp", [M]: "manuela" } });
    await setDoc(doc(a, "listings/L1"), { address: "Forge Lane", priceMonthly: 4080 });
    await setDoc(doc(a, "batches/2026-W45"), { week: "2026-W45", listingIds: ["L1"], completed: {} });
  });
});

describe("reading", () => {
  it("allows listed accounts", async () => {
    await assertSucceeds(getDoc(doc(db(P), "listings/L1")));
    await assertSucceeds(getDoc(doc(db(M), "config/access")));
  });
  it("denies strangers, unverified emails and anonymous users", async () => {
    await assertFails(getDoc(doc(db("x@example.com"), "listings/L1")));
    await assertFails(getDoc(doc(db(P, false), "listings/L1")));
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), "listings/L1")));
  });
});

describe("ratings", () => {
  it("lets each person write their own rating, including a skip", async () => {
    await assertSucceeds(setDoc(doc(db(P), "ratings/L1_philipp"), rating("philipp")));
    await assertSucceeds(setDoc(doc(db(M), "ratings/L1_manuela"), rating("manuela", { score: null, predictionAtRating: null })));
  });
  it("blocks writing as the other person or under the wrong id", async () => {
    await assertFails(setDoc(doc(db(P), "ratings/L1_manuela"), rating("manuela")));
    await assertFails(setDoc(doc(db(P), "ratings/L2_philipp"), rating("philipp")));
  });
  it("validates score and fields", async () => {
    await assertFails(setDoc(doc(db(P), "ratings/L1_philipp"), rating("philipp", { score: 6 })));
    await assertFails(setDoc(doc(db(P), "ratings/L1_philipp"), rating("philipp", { score: 2.5 })));
    await assertFails(setDoc(doc(db(P), "ratings/L1_philipp"), rating("philipp", { extra: true })));
    await assertFails(setDoc(doc(db(P), "ratings/L1_philipp"), rating("philipp", { createdAt: new Date(0) })));
  });
});

describe("app writes nothing else", () => {
  it("cannot touch listings, profiles or config", async () => {
    await assertFails(setDoc(doc(db(P), "listings/L1"), { priceMonthly: 1 }));
    await assertFails(setDoc(doc(db(P), "profiles/1"), { version: 1, rules: [] }));
    await assertFails(setDoc(doc(db(P), "config/access"), { raters: { "x@example.com": "philipp" } }));
  });
});

describe("batches", () => {
  it("marks only one's own completion", async () => {
    await assertSucceeds(updateDoc(doc(db(P), "batches/2026-W45"), { "completed.philipp": serverTimestamp() }));
    await assertFails(updateDoc(doc(db(P), "batches/2026-W45"), { "completed.manuela": serverTimestamp() }));
    await assertFails(updateDoc(doc(db(P), "batches/2026-W45"), { listingIds: [] }));
  });
});

describe("push subscriptions", () => {
  const H = "0123456789abcdef0123456789abcdef";
  const sub = (rater, extra = {}) => ({
    rater, endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "BPk", auth: "xyz" },
    userAgent: "test", createdAt: serverTimestamp(), ...extra,
  });
  it("lets each person register and remove their own devices", async () => {
    await assertSucceeds(setDoc(doc(db(P), `pushSubscriptions/philipp_${H}`), sub("philipp")));
    await assertSucceeds(getDoc(doc(db(P), `pushSubscriptions/philipp_${H}`)));
    await assertSucceeds(deleteDoc(doc(db(P), `pushSubscriptions/philipp_${H}`)));
  });
  it("keeps the other person's devices out of reach", async () => {
    await assertFails(setDoc(doc(db(P), `pushSubscriptions/manuela_${H}`), sub("manuela")));
    await assertFails(setDoc(doc(db(P), `pushSubscriptions/philipp_${H}`), sub("manuela")));
    await assertSucceeds(setDoc(doc(db(M), `pushSubscriptions/manuela_${H}`), sub("manuela")));
    await assertFails(getDoc(doc(db(P), `pushSubscriptions/manuela_${H}`)));
    await assertFails(deleteDoc(doc(db(P), `pushSubscriptions/manuela_${H}`)));
  });
  it("validates the stored fields", async () => {
    await assertFails(setDoc(doc(db(P), `pushSubscriptions/philipp_${H}`), sub("philipp", { endpoint: "http://insecure" })));
    await assertFails(setDoc(doc(db(P), `pushSubscriptions/philipp_${H}`), sub("philipp", { extra: 1 })));
    await assertFails(setDoc(doc(db(P), `pushSubscriptions/philipp_x`), sub("philipp")));
    await assertFails(setDoc(doc(db("x@example.com"), `pushSubscriptions/philipp_${H}`), sub("philipp")));
  });
});

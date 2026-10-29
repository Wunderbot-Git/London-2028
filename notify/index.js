// Cloud Function (gen2, Firestore trigger in eur3): sends Web Push to Philipp's and Manuela's devices.
//
// Two triggers point at this one entry point (see README.md):
//   batches/{week} created            → "Neue Inserate zum Bewerten" to every subscribed device, once
//                                       (batches/{week}.notifiedAt guards against retries)
//   pushSubscriptions/{id} created    → a confirmation to that one device
//
// The event payload (protobuf) is not decoded; the document path in the CloudEvent subject is enough.
// Env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (Secret Manager), VAPID_SUBJECT (https URL of the app).
const functions = require("@google-cloud/functions-framework");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const webpush = require("web-push");
const { parseSubject, batchPayload, welcomePayload, isGone } = require("./lib");

initializeApp();
const db = getFirestore();
webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);

async function send(docSnap, payload) {
  const { endpoint, keys } = docSnap.data();
  try {
    await webpush.sendNotification({ endpoint, keys }, JSON.stringify(payload), { TTL: 24 * 3600, urgency: "normal" });
    return "sent";
  } catch (err) {
    if (isGone(err)) {
      await docSnap.ref.delete();
      return "removed";
    }
    console.error(`push to ${docSnap.id} failed: ${err.statusCode ?? ""} ${err.body ?? err.message}`);
    return "failed";
  }
}

async function onBatch(week) {
  const ref = db.collection("batches").doc(week);
  // Claim the batch first so a retried event does not notify twice.
  const claimed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get("notifiedAt")) return null;
    tx.update(ref, { notifiedAt: FieldValue.serverTimestamp() });
    return snap.data();
  });
  if (!claimed) return console.log(`batch ${week}: already notified or missing`);
  const subs = await db.collection("pushSubscriptions").get();
  const results = await Promise.all(subs.docs.map((d) => send(d, batchPayload(week, claimed))));
  console.log(`batch ${week}: ${results.join(", ") || "no subscriptions"}`);
}

async function onSubscription(id) {
  const snap = await db.collection("pushSubscriptions").doc(id).get();
  if (!snap.exists) return;
  console.log(`welcome ${id}: ${await send(snap, welcomePayload(snap.get("rater")))}`);
}

functions.cloudEvent("notify", async (event) => {
  const target = parseSubject(event.subject);
  if (target?.collection === "batches") return onBatch(target.id);
  if (target?.collection === "pushSubscriptions") return onSubscription(target.id);
  console.log(`ignored event ${event.type} ${event.subject}`);
});

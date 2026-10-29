// Production store: Firebase Auth (Google) + Firestore. Collections and fields follow docs/spec.md §5.4.
// Listings, batches and profiles are written by n8n with a service account; the app only writes
// ratings and its own "completed" mark on a batch. firestore/firestore.rules enforces that.
import { initializeApp, type FirebaseOptions } from "firebase/app";
import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type Auth,
  type User,
} from "firebase/auth";
import {
  Timestamp,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  type Firestore,
} from "firebase/firestore";
import { subscriptionId, type SavedSubscription } from "./push";
import { ratingId, type Store } from "./store";
import type { Batch, Listing, Profile, Rater, Rating } from "./types";
import { RATERS } from "./types";

// Firestore Timestamps → ISO strings, recursively, so views only deal with plain data.
function plain<T>(v: unknown): T {
  if (v instanceof Timestamp) return v.toDate().toISOString() as T;
  if (Array.isArray(v)) return v.map((x) => plain(x)) as T;
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)])) as T;
  }
  return v as T;
}

export interface Session {
  user: User;
  rater: Rater;
  store: Store;
}

export class FirebaseApp {
  readonly auth: Auth;
  readonly db: Firestore;

  constructor(options: FirebaseOptions) {
    const app = initializeApp(options);
    this.auth = getAuth(app);
    this.db = getFirestore(app);
  }

  onUser(cb: (u: User | null) => void) {
    return onAuthStateChanged(this.auth, cb);
  }

  signIn() {
    return signInWithPopup(this.auth, new GoogleAuthProvider());
  }

  signOut() {
    return signOut(this.auth);
  }

  /**
   * Looks the signed-in account up in config/access ({ raters: { "<email>": "philipp" | "manuela" } }).
   * Returns null when the account is not on the allowlist (the rules then deny the read as well).
   */
  async session(user: User): Promise<Session | null> {
    try {
      const snap = await getDoc(doc(this.db, "config", "access"));
      const raters = (snap.data()?.raters ?? {}) as Record<string, string>;
      const rater = raters[(user.email ?? "").toLowerCase()];
      if (!RATERS.includes(rater as Rater)) return null;
      return { user, rater: rater as Rater, store: this.store() };
    } catch {
      return null;
    }
  }

  /** Stores this browser's push subscription so the notify function can reach it. */
  async savePushSubscription(rater: Rater, sub: SavedSubscription) {
    await setDoc(doc(this.db, "pushSubscriptions", await subscriptionId(rater, sub.endpoint)), {
      rater,
      endpoint: sub.endpoint,
      keys: sub.keys,
      userAgent: navigator.userAgent.slice(0, 300),
      createdAt: serverTimestamp(),
    });
  }

  async deletePushSubscription(rater: Rater, endpoint: string) {
    await deleteDoc(doc(this.db, "pushSubscriptions", await subscriptionId(rater, endpoint)));
  }

  private store(): Store {
    const db = this.db;
    return {
      demo: false,
      async currentBatch() {
        const snap = await getDocs(query(collection(db, "batches"), orderBy("week", "desc"), limit(1)));
        const d = snap.docs[0];
        if (!d) return null;
        const b = plain<Batch>(d.data());
        return { ...b, week: b.week ?? d.id, listingIds: b.listingIds ?? [], completed: b.completed ?? {} };
      },
      async listings(ids) {
        const snaps = await Promise.all(ids.map((id) => getDoc(doc(db, "listings", id))));
        return snaps.filter((s) => s.exists()).map((s) => ({ ...plain<Listing>(s.data()), id: s.id }));
      },
      async ratings(rater, listingIds) {
        const snaps = await Promise.all(
          listingIds.map((id) => getDoc(doc(db, "ratings", ratingId(id, rater)))),
        );
        const out: Record<string, Rating> = {};
        for (const s of snaps) if (s.exists()) {
          const r = plain<Rating>(s.data());
          out[r.listingId] = r;
        }
        return out;
      },
      async saveRating(r) {
        await setDoc(doc(db, "ratings", ratingId(r.listingId, r.rater)), {
          listingId: r.listingId,
          rater: r.rater,
          score: r.score,
          tags: r.tags,
          note: r.note,
          predictionAtRating: r.predictionAtRating,
          createdAt: serverTimestamp(),
        });
      },
      async markCompleted(week, rater) {
        await updateDoc(doc(db, "batches", week), { [`completed.${rater}`]: serverTimestamp() });
      },
      async latestProfile() {
        const snap = await getDocs(query(collection(db, "profiles"), orderBy("version", "desc"), limit(1)));
        const d = snap.docs[0];
        return d ? plain<Profile>(d.data()) : null;
      },
    };
  }
}

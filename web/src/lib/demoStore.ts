// Local demo: sample listings, ratings kept in localStorage. Lets the UI run without a GCP project.
import { SAMPLE_BATCH, SAMPLE_LISTINGS, SAMPLE_PROFILE } from "../data/sample";
import { ratingId, type Store } from "./store";
import type { Batch, Rating } from "./types";

const KEY = "lwr-demo-v1";

interface DemoState {
  ratings: Record<string, Rating>;
  completed: Batch["completed"];
}

function load(): DemoState {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (s?.ratings) return s;
  } catch {
    // storage unavailable or corrupt: start fresh
  }
  return { ratings: {}, completed: {} };
}

function save(s: DemoState) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // ignore: the demo still works for this page view
  }
}

export function resetDemo() {
  save({ ratings: {}, completed: {} });
}

export const demoStore: Store = {
  demo: true,
  async currentBatch() {
    return { ...SAMPLE_BATCH, completed: { ...load().completed } };
  },
  async listings(ids) {
    return ids.map((id) => SAMPLE_LISTINGS.find((l) => l.id === id)).filter((l) => l != null);
  },
  async ratings(rater, listingIds) {
    const all = load().ratings;
    const out: Record<string, Rating> = {};
    for (const id of listingIds) {
      const r = all[ratingId(id, rater)];
      if (r) out[id] = r;
    }
    return out;
  },
  async saveRating(rating) {
    const s = load();
    s.ratings[ratingId(rating.listingId, rating.rater)] = rating;
    save(s);
  },
  async markCompleted(_week, rater) {
    const s = load();
    s.completed[rater] = new Date().toISOString();
    save(s);
  },
  async latestProfile() {
    return SAMPLE_PROFILE;
  },
};

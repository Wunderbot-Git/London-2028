// Data access used by the views. Two implementations: Firestore (production) and demo (local sample data).
import type { Batch, Listing, Profile, Rater, Rating } from "./types";

export interface Store {
  /** True for the local demo with invented/sample listings. */
  readonly demo: boolean;
  /** The newest weekly batch, or null if n8n has not built one yet. */
  currentBatch(): Promise<Batch | null>;
  listings(ids: string[]): Promise<Listing[]>;
  /** Ratings of one rater for the given listings, keyed by listingId. */
  ratings(rater: Rater, listingIds: string[]): Promise<Record<string, Rating>>;
  saveRating(rating: Rating): Promise<void>;
  markCompleted(week: string, rater: Rater): Promise<void>;
  latestProfile(): Promise<Profile | null>;
}

export const ratingId = (listingId: string, rater: Rater) => `${listingId}_${rater}`;

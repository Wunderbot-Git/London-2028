// Mirrors the Firestore data model in docs/spec.md §5.4.
// Timestamps are plain ISO strings in the app; the Firestore store converts them.

export type Rater = "philipp" | "manuela";
export const RATERS: Rater[] = ["philipp", "manuela"];
export const RATER_NAME: Record<Rater, string> = { philipp: "Philipp", manuela: "Manuela" };

export type LetType = "short_let" | "flexible" | "periodic" | "corporate" | "licence" | "unknown";
export type Furnished = "furnished" | "part" | "unfurnished" | "either" | "unknown";
export type ListingStatus = "new" | "queued" | "reviewed" | "archived";
export type PropertyType = "flat" | "maisonette" | "detached" | "semi_detached" | "terraced" | "house" | "unknown";

export interface Commute {
  walkMin?: number | null;
  transitMin?: number | null;
  transitSummary?: string | null;
  driveMin?: number | null;
  computedAt?: string | null;
}

export interface Prediction {
  score: number;
  rationale: string;
  profileVersion?: number | null;
  model?: string | null;
  createdAt?: string | null;
}

export interface Listing {
  id: string;
  source: string; // rightmove | zoopla | openrent | agency:<name>
  sourceId?: string;
  url?: string | null;
  fingerprint?: string;
  duplicateOf?: string | null;
  address: string;
  postcode: string; // e.g. "TW10 7"
  area: string;
  lat?: number | null;
  lng?: number | null;
  priceMonthly: number;
  billsIncluded?: boolean | null;
  letType: LetType;
  minTermMonths?: number | null;
  maxTermMonths?: number | null;
  availableFrom?: string | null;
  beds: number | null;
  baths: number | null;
  furnished: Furnished;
  propertyType?: PropertyType | null;
  agent?: string | null;
  priceReduced?: boolean | null;
  garden?: boolean | null;
  parking?: boolean | null;
  epc?: string | null;
  photos?: string[];
  commute?: Commute | null;
  flags?: string[];
  prediction?: Prediction | null;
  status?: ListingStatus;
  reviewWeek?: string | null;
  // Not in the spec's field list; free-text highlight shown as "Besonderheit".
  highlight?: string | null;
  // Demo data only: marks invented listings.
  sample?: boolean;
}

export interface Rating {
  listingId: string;
  rater: Rater;
  score: number | null; // null = skipped
  tags: string[];
  note: string;
  predictionAtRating: number | null;
  createdAt: string;
}

export interface Batch {
  week: string; // e.g. "2026-W45"
  listingIds: string[];
  createdAt?: string;
  completed: Partial<Record<Rater, string>>;
}

export interface Profile {
  version: number;
  createdAt?: string;
  basedOnRatings?: number;
  hardFilters?: { maxPriceMonthly?: number; minBeds?: number; maxCommuteMin?: number };
  rules: string[];
  fewShot?: string[];
  metrics?: { mae?: number; hitRateWithin1?: number; n?: number };
  confirmedBy?: string[];
}

export const TAGS = [
  "Zu teuer",
  "Zu weit",
  "Zu klein",
  "Kein Garten",
  "Laufzeit",
  "Lage",
  "Das Haus",
  "Preis–Leistung",
] as const;

export const SCORE_WORD: Record<number, string> = {
  1: "Nein",
  2: "Eher nicht",
  3: "Vielleicht",
  4: "Interessant",
  5: "Unbedingt",
};

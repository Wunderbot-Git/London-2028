// Listings from prototype v2, in the Firestore data model. Used only in demo mode.
// Entries with `sample: true` are invented; the others were real listings in October 2026.
import type { Batch, Listing, Profile } from "../lib/types";

export const SAMPLE_WEEK = "2026-W44";

export const SAMPLE_LISTINGS: Listing[] = [
  {
    id: "L1", source: "zoopla", url: "https://www.zoopla.co.uk/to-rent/details/74426560/",
    address: "Petersham Road", postcode: "TW10", area: "Richmond",
    priceMonthly: 6865, billsIncluded: true, letType: "short_let", minTermMonths: 2, maxTermMonths: 5,
    beds: 3, baths: 2, furnished: "furnished", garden: false, epc: "C", highlight: "Balkon mit Flussblick",
    commute: { walkMin: 22, transitMin: 8, transitSummary: "Bus 65" }, flags: ["term_too_short"],
    prediction: { score: 4, rationale: "Nah an der Schule, Nebenkosten inklusive. Kein Garten, Laufzeit zu kurz." },
  },
  {
    id: "L2", source: "zoopla", url: "https://www.zoopla.co.uk/to-rent/details/73843699/",
    address: "Forge Lane", postcode: "TW10", area: "Petersham",
    priceMonthly: 4080, billsIncluded: false, letType: "periodic",
    beds: 3, baths: 2, furnished: "either", garden: true, parking: true, epc: "C", highlight: "Eigener Parkplatz",
    availableFrom: "2026-09-17", commute: { walkMin: 5 }, flags: ["periodic_risk"],
    prediction: { score: 4, rationale: "Beste Lage zur Schule und günstig. Reguläre Miete ist das Risiko." },
  },
  {
    id: "L3", source: "zoopla", url: "https://www.zoopla.co.uk/to-rent/details/71978652/",
    address: "Shortlands Road", postcode: "KT2", area: "North Kingston",
    priceMonthly: 5750, billsIncluded: false, letType: "short_let",
    beds: 3, baths: 2, furnished: "furnished", garden: true, epc: "D", highlight: "Serviced, WLAN inklusive",
    commute: { driveMin: 12, transitMin: 28, transitSummary: "dem Bus" },
    prediction: { score: 3, rationale: "Familienhaus mit Garten. Mit dem Bus fast eine halbe Stunde zur Schule." },
  },
  {
    id: "L4", source: "rightmove", url: "https://www.rightmove.co.uk/properties/90814923",
    address: "Compton Road", postcode: "SW19", area: "Wimbledon",
    priceMonthly: 5500, billsIncluded: false, letType: "flexible", minTermMonths: 1, maxTermMonths: 6,
    beds: 5, baths: 3, furnished: "either", garden: true, highlight: "3 Min. zum Bahnhof",
    availableFrom: "2026-09-11", commute: { driveMin: 25, transitMin: 45, transitSummary: "Bahn und Bus" },
    prediction: { score: 2, rationale: "Laufzeit perfekt, viel Platz. Für den täglichen Schulweg zu weit." },
  },
  {
    id: "L5", source: "openrent", sample: true,
    address: "Ham Common", postcode: "TW10", area: "Ham",
    priceMonthly: 6200, billsIncluded: true, letType: "short_let", minTermMonths: 6, maxTermMonths: 6,
    beds: 4, baths: 2, furnished: "furnished", garden: true, epc: "D", highlight: "Direkt am Common",
    availableFrom: "2028-01-01", commute: { walkMin: 10 },
    prediction: { score: 5, rationale: "Idealfall: Laufzeit, Lage, Garten und Nebenkosten passen." },
  },
  {
    id: "L6", source: "rightmove", sample: true,
    address: "Upper Richmond Road West", postcode: "SW14", area: "East Sheen",
    priceMonthly: 4600, billsIncluded: false, letType: "periodic",
    beds: 3, baths: 1, furnished: "furnished", garden: false, epc: "C", highlight: "An der Hauptstraße",
    commute: { transitMin: 20, transitSummary: "Bus 371" }, flags: ["periodic_risk"],
    prediction: { score: 2, rationale: "Wohnung an der Hauptstraße, ein Bad, reguläre Miete." },
  },
  {
    id: "L7", source: "zoopla", url: "https://www.zoopla.co.uk/to-rent/details/70263048",
    address: "Dickerage Road", postcode: "KT1", area: "Coombe, Kingston",
    priceMonthly: 9500, billsIncluded: false, letType: "corporate", maxTermMonths: 10,
    beds: 5, baths: 3, furnished: "part", garden: true, parking: true, highlight: "Parkplatz",
    availableFrom: "2026-08-01", commute: { driveMin: 15 }, flags: ["over_budget"],
    prediction: { score: 2, rationale: "Laufzeit passt, Preis nicht." },
  },
  {
    id: "L8", source: "openrent", sample: true,
    address: "Richmond Hill", postcode: "TW10", area: "Richmond",
    priceMonthly: 3900, billsIncluded: true, letType: "short_let", minTermMonths: 6, maxTermMonths: 6,
    beds: 2, baths: 1, furnished: "furnished", garden: false, epc: "B", highlight: "Blick auf den Park",
    availableFrom: "2028-01-01", commute: { transitMin: 15, transitSummary: "Bus 65" }, flags: ["few_beds"],
    prediction: { score: 1, rationale: "Günstig und Laufzeit passt, aber zu klein für vier." },
  },
];

export const SAMPLE_BATCH: Batch = {
  week: SAMPLE_WEEK,
  listingIds: SAMPLE_LISTINGS.map((l) => l.id),
  completed: {},
};

export const SAMPLE_PROFILE: Profile = { version: 0, rules: [] };

// Turns data-model fields into the German labels the review card shows (spec §6.1).
import type { Commute, Furnished, LetType, Listing } from "./types";

export const gbp = (n: number) => "£" + Math.round(n).toLocaleString("en-GB");

export const weeklyPrice = (pcm: number) => Math.round((pcm * 12) / 52);

const LET_LABEL: Record<LetType, string> = {
  short_let: "Short Let",
  flexible: "Flexibel",
  periodic: "Unbefristete Miete",
  corporate: "Corporate Let",
  licence: "Licence to occupy",
  unknown: "Mietform unklar",
};

export function letLabel(l: Pick<Listing, "letType" | "minTermMonths" | "maxTermMonths">): string {
  const base = LET_LABEL[l.letType] ?? LET_LABEL.unknown;
  const min = l.minTermMonths ?? null;
  const max = l.maxTermMonths ?? null;
  if (min && max) return min === max ? `${base}, ${max} Monate` : `${base}, ${min}–${max} Monate`;
  if (max) return `${base}, max. ${max} Monate`;
  if (min) return `${base}, ab ${min} Monaten`;
  return base;
}

const FURNISHED_LABEL: Record<Furnished, string> = {
  furnished: "Möbliert",
  part: "Teilmöbliert",
  unfurnished: "Unmöbliert",
  either: "Möbliert oder leer",
  unknown: "Unklar",
};
export const furnishedLabel = (f: Furnished) => FURNISHED_LABEL[f] ?? FURNISHED_LABEL.unknown;

// Walking wins when it is reasonable; otherwise the faster of transit and car.
const WALK_OK_MIN = 25;

export function commuteLines(c: Commute | null | undefined): { main: string | null; alt: string | null } {
  if (!c) return { main: null, alt: null };
  const options: { min: number; text: string }[] = [];
  if (c.walkMin != null) options.push({ min: c.walkMin, text: `${c.walkMin} Min. zu Fuß` });
  if (c.transitMin != null)
    options.push({
      min: c.transitMin,
      text: c.transitSummary ? `${c.transitMin} Min. mit ${c.transitSummary}` : `${c.transitMin} Min. mit ÖPNV`,
    });
  if (c.driveMin != null) options.push({ min: c.driveMin, text: `${c.driveMin} Min. mit dem Auto` });
  if (!options.length) return { main: null, alt: null };

  const walk = c.walkMin != null && c.walkMin <= WALK_OK_MIN ? options[0] : null;
  const sorted = [...options].sort((a, b) => a.min - b.min);
  const main = walk ?? sorted[0];
  const alt = sorted.find((o) => o !== main && o.min <= 60) ?? null;
  return { main: main.text, alt: alt?.text ?? null };
}

const FLAG_LABEL: Record<string, string> = {
  term_too_short: "Laufzeit zu kurz",
  over_budget: "Über Budget",
  few_beds: "Zu wenige Schlafzimmer",
  periodic_risk: "Reguläre Miete: Vermieter sucht wohl Langzeitmieter",
};
export const flagLabel = (f: string) => FLAG_LABEL[f] ?? f;

export function availableLabel(iso: string | null | undefined): string {
  if (!iso) return "Auf Anfrage";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  if (d.getTime() <= Date.now()) return "Ab sofort";
  return d.toLocaleDateString("de-DE", { day: "numeric", month: "short", year: "numeric" });
}

export function sourceLabel(source: string): string {
  if (source.startsWith("agency:")) return source.slice(7);
  const known: Record<string, string> = { rightmove: "Rightmove", zoopla: "Zoopla", openrent: "OpenRent" };
  return known[source] ?? source;
}

// Stable hue per listing for the placeholder tile until real photos are allowed (spec §8 #9).
export function hue(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}

export const postcodeDistrict = (pc: string) => pc.trim().split(/\s+/)[0] ?? pc;

export function deviationLabel(score: number, prediction: number): { text: string; hit: boolean } {
  const d = Math.abs(score - prediction);
  if (d === 0) return { text: "Treffer", hit: true };
  if (d === 1) return { text: "Knapp daneben", hit: true };
  return { text: `${d} daneben`, hit: false };
}

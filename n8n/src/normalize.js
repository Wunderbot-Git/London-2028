// Normalising (spec §5.3 node 5): price to pcm, let type and furnishing to the enums of §5.4,
// postcode sector, area, fingerprint for duplicates, and the flags that need only listing data.

/** Postcode district → area name, for when the mail names no place (spec §5.2 areas first). */
export const AREAS = {
  TW10: "Richmond / Ham / Petersham",
  TW9: "Richmond / Kew",
  TW1: "Twickenham",
  TW2: "Twickenham",
  KT1: "Kingston",
  KT2: "North Kingston",
  KT3: "New Malden",
  SW13: "Barnes",
  SW14: "East Sheen / Mortlake",
  SW15: "Putney / Roehampton",
  SW18: "Southfields / Wandsworth",
  SW19: "Wimbledon",
  SW20: "Raynes Park",
};

export const LET_TYPES = ["short_let", "flexible", "periodic", "corporate", "licence", "unknown"];
export const FURNISHED = ["furnished", "part", "unfurnished", "either", "unknown"];

export function letTypeFromText(t) {
  if (!t) return "unknown";
  const s = t.toLowerCase();
  if (/licen[cs]e/.test(s)) return "licence";
  if (/corporate/.test(s)) return "corporate";
  if (/short/.test(s)) return "short_let";
  if (/flexible/.test(s)) return "flexible";
  if (/long/.test(s)) return "periodic";
  return "unknown";
}

export function termFromText(t) {
  if (!t) return { min: null, max: null };
  const range = /(\d+)\s*(?:-|to)\s*(\d+)\s*months?/i.exec(t);
  if (range) return { min: Number(range[1]), max: Number(range[2]) };
  const min = /min(?:imum)?\.?\s*(?:term|tenancy)?\s*:?\s*(\d+)\s*months?/i.exec(t);
  const max = /max(?:imum)?\.?\s*(?:term|tenancy)?\s*:?\s*(\d+)\s*months?/i.exec(t);
  return { min: min ? Number(min[1]) : null, max: max ? Number(max[1]) : null };
}

export function furnishedFromText(t) {
  if (!t) return "unknown";
  const s = t.toLowerCase();
  if (/furnished\s+or\s+unfurnished/.test(s)) return "either";
  if (/part/.test(s)) return "part";
  if (/unfurnished/.test(s)) return "unfurnished";
  if (/furnished/.test(s)) return "furnished";
  return "unknown";
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "now", "1st January 2028", "01/01/2028", "Jan 2028" → ISO date; "now" → today. */
export function dateFromText(t, today = new Date()) {
  if (!t) return null;
  const s = t.trim().toLowerCase();
  if (/^(now|immediately)$/.test(s)) return today.toISOString().slice(0, 10);
  const iso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  let m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\s+(\d{4})$/.exec(s);
  if (m && MONTHS.indexOf(m[2].slice(0, 3)) >= 0) return iso(m[3], MONTHS.indexOf(m[2].slice(0, 3)) + 1, m[1]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (m) return iso(m[3].length === 2 ? `20${m[3]}` : m[3], m[2], m[1]);
  m = /^([a-z]{3,9})\s+(\d{4})$/.exec(s);
  if (m && MONTHS.indexOf(m[1].slice(0, 3)) >= 0) return iso(m[2], MONTHS.indexOf(m[1].slice(0, 3)) + 1, 1);
  return null;
}

/** Parser output (texts) → the extraction shape the Claude fallback also returns. */
export function fromParser(l, today) {
  const term = termFromText(l.letText);
  return {
    url: l.url,
    sourceId: l.sourceId,
    address: l.address,
    postcode: l.postcode,
    area: null,
    price: l.price,
    pricePeriod: l.pricePeriod,
    billsIncluded: l.billsIncluded,
    letType: letTypeFromText(l.letText),
    minTermMonths: term.min,
    maxTermMonths: term.max,
    availableFrom: dateFromText(l.availableText, today),
    beds: l.beds,
    baths: l.baths,
    furnished: furnishedFromText(l.furnishedText),
    garden: l.garden,
    parking: l.parking,
    epc: null,
    highlight: null,
    photos: l.photos ?? [],
  };
}

/** "tw10 7ah" → { full: "TW10 7AH", district: "TW10", sector: "TW10 7" }. */
export function splitPostcode(pc) {
  if (!pc) return { full: null, district: null, sector: null };
  const m = /^([A-Z]{1,2}\d[A-Z\d]?)\s*(?:(\d)([A-Z]{2}))?$/.exec(pc.trim().toUpperCase());
  if (!m) return { full: null, district: null, sector: null };
  return {
    full: m[3] ? `${m[1]} ${m[2]}${m[3]}` : null,
    district: m[1],
    sector: m[2] ? `${m[1]} ${m[2]}` : m[1],
  };
}

export function priceMonthly(price, period) {
  if (price == null) return null;
  // Alert mails without a period are monthly in practice; weekly prices say "pw".
  return period === "week" ? Math.round((price * 52) / 12) : Math.round(price);
}

/** Address normalised for duplicate detection across portals. */
export function fingerprint(address, district, beds) {
  const a = (address ?? "")
    .toLowerCase()
    .replace(/\b(flat|apartment|apt|unit)\s*\w+\b/g, "")
    .replace(/\b[a-z]{1,2}\d[a-z\d]?\s*\d[a-z]{2}\b/g, "")
    .replace(/\b(road|rd)\b/g, "rd")
    .replace(/\b(street|st)\b/g, "st")
    .replace(/\b(avenue|ave)\b/g, "ave")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w && !/^(london|surrey|richmond upon thames|uk)$/.test(w))
    .join(" ");
  return `${a}|${(district ?? "").toLowerCase()}|${beds ?? ""}`;
}

/** Firestore document ID: stable per portal listing so re-sent alerts update instead of duplicating. */
export function listingId(source, sourceId, fp) {
  const base = sourceId ? `${source}-${sourceId}` : `${source}-${hash(fp)}`;
  return base.replace(/[^A-Za-z0-9_.-]/g, "-");
}

function hash(s) {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h.toString(36);
}

/** Flags from listing data and config/criteria. Commute flags are added once TfL has answered. */
export function flags(l, criteria = {}) {
  const f = [];
  if (l.maxTermMonths != null && l.maxTermMonths < 6) f.push("term_too_short");
  if (criteria.maxPriceMonthly != null && l.priceMonthly != null && l.priceMonthly > criteria.maxPriceMonthly) f.push("over_budget");
  if (criteria.minBeds != null && l.beds != null && l.beds < criteria.minBeds) f.push("few_beds");
  if (l.letType === "periodic") f.push("periodic_risk");
  return f;
}

/** Extraction shape + mail context → listing fields of spec §5.4 (without commute/prediction). */
export function normalize(x, ctx) {
  const pc = splitPostcode(x.postcode);
  const district = pc.district;
  const address = (x.address ?? "").trim() || (district ? `${district}` : "Adresse unbekannt");
  const area = x.area?.trim() || areaFromAddress(address) || AREAS[district] || "";
  const beds = x.beds ?? null;
  const fp = fingerprint(address, district, beds);
  const l = {
    source: ctx.source,
    sourceId: x.sourceId ?? null,
    url: x.url ?? null,
    fingerprint: fp,
    address,
    postcode: pc.sector ?? "",
    _postcodeFull: pc.full,
    area,
    priceMonthly: priceMonthly(x.price, x.pricePeriod),
    billsIncluded: x.billsIncluded ?? null,
    letType: LET_TYPES.includes(x.letType) ? x.letType : "unknown",
    minTermMonths: x.minTermMonths ?? null,
    maxTermMonths: x.maxTermMonths ?? null,
    availableFrom: x.availableFrom ?? null,
    beds,
    baths: x.baths ?? null,
    furnished: FURNISHED.includes(x.furnished) ? x.furnished : "unknown",
    garden: x.garden ?? null,
    parking: x.parking ?? null,
    epc: x.epc ?? null,
    highlight: x.highlight ?? null,
    photos: (x.photos ?? []).slice(0, 6),
    rawMessageId: ctx.messageId,
    extractedBy: ctx.extractedBy,
  };
  l.id = listingId(l.source, l.sourceId, fp);
  l.flags = flags(l, ctx.criteria);
  return l;
}

function areaFromAddress(address) {
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1].replace(/\b[A-Z]{1,2}\d[A-Z\d]?(\s*\d[A-Z]{2})?\b/g, "").trim();
  return last && !/^london$/i.test(last) ? last : parts.length > 2 ? parts[parts.length - 2] : null;
}

/** Next Monday as yyyymmdd – TfL plans the school run for a normal weekday at 08:15 arrival. */
export function nextMonday(today = new Date()) {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + (((8 - d.getUTCDay()) % 7) || 7));
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

// Turns portal alert mails into listing candidates (spec §5.3, nodes 2–3).
// No HTML library is available in n8n Code nodes, so the mail is flattened to text with
// [[LINK:url]] and [[IMG:src]] markers and each listing is read from the text after its link.
// Anything incomplete is marked for the Gemini fallback instead of being guessed.

export const PORTALS = [
  { source: "rightmove", sender: /rightmove\.co\.uk/i, id: /rightmove\.co\.uk\/properties\/(\d{6,})/i },
  { source: "zoopla", sender: /zoopla\.co\.uk/i, id: /zoopla\.co\.uk\/to-rent\/details\/(\d{6,})/i },
  { source: "openrent", sender: /openrent\.co\.uk/i, id: /openrent\.co\.uk\/(?:property-to-rent\/[^\s"'?#]*\/)?(\d{6,})(?=[/?#"'\s]|$)/i },
];

export function portalForSender(from) {
  return PORTALS.find((p) => p.sender.test(from ?? "")) ?? null;
}

/** "agency:<domain>" for senders that are not one of the portals. */
export function sourceForSender(from) {
  const p = portalForSender(from);
  if (p) return p.source;
  const domain = /@([^>\s]+)/.exec(from ?? "")?.[1]?.toLowerCase() ?? "unknown";
  return `agency:${domain.replace(/^(mail|email|news|info)\./, "")}`;
}

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", pound: "£", euro: "€",
  middot: "·", bull: "•", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
};
export function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

/**
 * Tracking links wrap the real URL (as a query parameter, sometimes base64- or double-encoded).
 * Returns the first portal listing URL found inside, or the link itself.
 */
export function unwrapUrl(href) {
  const candidates = [href];
  // Query parameters read by hand: n8n's Code sandbox has no URL global.
  const query = href.split("#")[0].split("?").slice(1).join("?");
  for (const pair of query ? query.split("&") : []) {
    const v = pair.slice(pair.indexOf("=") + 1);
    if (!v || v === pair) continue;
    for (const decoded of [safeDecode(v), safeDecode(safeDecode(v))]) candidates.push(decoded);
    if (/^[A-Za-z0-9+/_-]{20,}={0,2}$/.test(v) && typeof atob === "function") {
      try {
        candidates.push(atob(v.replace(/-/g, "+").replace(/_/g, "/")));
      } catch {
        // not base64
      }
    }
  }
  for (const c of candidates) {
    for (const p of PORTALS) {
      const m = p.id.exec(c);
      if (m) return { url: c.split(/[\s"']/)[0], source: p.source, sourceId: m[1] };
    }
  }
  return { url: href, source: null, sourceId: null };
}

function safeDecode(v) {
  try {
    return decodeURIComponent(v.replace(/\+/g, " "));
  } catch {
    return v;
  }
}

/** HTML → text with [[LINK:url]] / [[IMG:src]] markers and line breaks at block elements. */
export function htmlToText(html) {
  let s = html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi, (_, src) => ` [[IMG:${decodeEntities(src)}]] `);
  s = s.replace(/<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi, (_, href) => ` [[LINK:${decodeEntities(href)}]] `);
  s = s.replace(/<\/?(p|div|tr|td|th|li|h[1-6]|table|br|section|article)\b[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  return s
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

const LINK_RE = /\[\[LINK:([^\]]+)\]\]/g;
const IMG_RE = /\[\[IMG:([^\]]+)\]\]/g;
const stripMarkers = (s) => s.replace(LINK_RE, " ").replace(IMG_RE, " ").replace(/[ \t]+/g, " ");

/**
 * Splits the flattened mail into one text block per listing: from the line with the first link
 * to a listing up to where the next listing's block starts.
 */
export function listingBlocks(text) {
  const hits = [];
  for (const m of text.matchAll(LINK_RE)) {
    const u = unwrapUrl(m[1]);
    if (u.sourceId) hits.push({ ...u, index: m.index });
  }
  const firstById = new Map();
  for (const h of hits) if (!firstById.has(h.sourceId)) firstById.set(h.sourceId, h);
  const firsts = [...firstById.values()].sort((a, b) => a.index - b.index);

  // Each block starts at the line holding its first link (photo links usually come first).
  const starts = firsts.map((h, i) => {
    const prevEnd = i ? firsts[i - 1].index + 1 : 0;
    return Math.max(prevEnd, text.lastIndexOf("\n", h.index - 1) + 1);
  });
  return firsts.map((h, i) => ({
    url: h.url,
    source: h.source,
    sourceId: h.sourceId,
    text: text.slice(starts[i], i + 1 < firsts.length ? starts[i + 1] : undefined),
  }));
}

const num = (s) => Number(String(s).replace(/,/g, ""));

/** Reads what it can from a listing's text block. Missing fields stay null. */
export function readBlock(block) {
  const raw = block.text;
  const text = stripMarkers(raw);
  const lower = text.toLowerCase();
  const out = {
    source: block.source,
    sourceId: block.sourceId,
    url: block.url,
    address: null,
    postcode: null,
    price: null,
    pricePeriod: null,
    billsIncluded: null,
    letText: null,
    beds: null,
    baths: null,
    furnishedText: null,
    garden: null,
    parking: null,
    availableText: null,
    photos: [...raw.matchAll(IMG_RE)].map((m) => m[1]).filter((src) => !/logo|icon|spacer|pixel|tracking/i.test(src)),
  };

  const price = /£\s?([\d,]{3,})(?:\.\d{2})?\s*(pcm|pw|p\/w|p\/m|per\s+month|per\s+week|a\s+month|a\s+week|monthly|weekly)?/i.exec(text);
  if (price) {
    out.price = num(price[1]);
    const period = (price[2] ?? "").toLowerCase();
    out.pricePeriod = /w/.test(period) ? "week" : period ? "month" : null;
  }

  const beds = /(\d+)\s*(?:-\s*)?(?:bed(?:room)?s?|br)\b/i.exec(text);
  if (beds) out.beds = num(beds[1]);
  else if (/\bstudio\b/i.test(text)) out.beds = 0;
  const baths = /(\d+)\s*(?:bath(?:room)?s?)\b/i.exec(text);
  if (baths) out.baths = num(baths[1]);

  const pc = /\b([A-Z]{1,2}\d[A-Z\d]?)(?:\s*(\d[A-Z]{2}))?\b/.exec(text.replace(/£[\d,.]+/g, ""));
  if (pc) out.postcode = pc[2] ? `${pc[1]} ${pc[2]}` : pc[1];

  // The address is usually the line that carries a comma and a place or postcode.
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const addr = lines.find(
    (l) => l.length <= 120 && /,/.test(l) && !/£|bed|bath/i.test(l) && /[A-Za-z]{3,}/.test(l),
  );
  if (addr) out.address = addr;

  if (/bills?\s+(?:are\s+)?included|all\s+bills|inclusive\s+of\s+bills|bills\s+inc/i.test(text)) out.billsIncluded = true;
  // Let type and term are often separate phrases ("Short let, 2-5 months"); keep all of them.
  const letHits = text.match(/short[\s-]?let|short\s+term|flexible|corporate|licen[cs]e|long[\s-]?let|long\s+term|\d+\s*(?:-|to)\s*\d+\s*months?|min(?:imum)?\.?\s*(?:term|tenancy)?\s*:?\s*\d+\s*months?|max(?:imum)?\.?\s*(?:term|tenancy)?\s*:?\s*\d+\s*months?/gi);
  if (letHits) out.letText = letHits.join(", ");
  const furn = /part[\s-]?furnished|unfurnished|furnished\s+or\s+unfurnished|furnished/i.exec(text);
  if (furn) out.furnishedText = furn[0];
  if (/\bgarden\b/i.test(lower)) out.garden = !/no\s+garden/i.test(lower);
  if (/\b(parking|driveway|garage)\b/i.test(lower)) out.parking = !/no\s+parking/i.test(lower);
  const avail = /available\s+(?:from\s+)?(now|immediately|\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9}\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4}|[A-Za-z]{3,9}\s+\d{4})/i.exec(text);
  if (avail) out.availableText = avail[1];
  return out;
}

/** True when the parser found enough to skip the Gemini fallback (spec §5.3 node 4). */
export function isComplete(l) {
  return l.price != null && l.beds != null && (l.address != null || l.postcode != null) && l.url != null;
}

/** Full parse of one alert mail ({ id, from, subject, date, html, text }, see agentmail.js). */
export function parseMail(mail) {
  const from = mail.from?.value?.[0]?.address ?? mail.from?.text ?? String(mail.from ?? "");
  const source = sourceForSender(from);
  const text = mail.html ? htmlToText(mail.html) : String(mail.text ?? "");
  const listings = listingBlocks(text).map(readBlock);
  const needsLlm = !portalForSender(from) || listings.length === 0 || listings.some((l) => !isComplete(l));
  return {
    messageId: mail.id ?? mail.messageId ?? null,
    from,
    subject: mail.subject ?? "",
    receivedAt: mail.date ?? null,
    source,
    text,
    listings,
    needsLlm,
  };
}

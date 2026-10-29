// Reads one open listing page (Rightmove, Zoopla, OnTheMarket) into the fields the review app
// shows. Runs inside the page in the user's own Chrome (Claude in Chrome, javascript_tool):
//   <contents of this file> ; extractListing(window)
// No network requests: only what the page already holds (embedded JSON, visible text).
// Unknown values stay null. Returned keys match listings/{id} in Firestore (docs/spec.md §5.4).

function extractListing(win) {
  const doc = win.document;
  const host = win.location.hostname;

  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const pad = (n) => String(n).padStart(2, "0");
  function isoDate(s) {
    if (!s) return null;
    const t = String(s).trim().toLowerCase();
    if (/^(now|immediately|available now|available immediately)$/.test(t)) {
      const d = new Date();
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }
    let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
    if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
    m = /(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\s+(\d{4})/.exec(t);
    if (m && MONTHS.includes(m[2].slice(0, 3))) return `${m[3]}-${pad(MONTHS.indexOf(m[2].slice(0, 3)) + 1)}-${pad(m[1])}`;
    m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  }
  function furnished(s) {
    if (!s) return null;
    const t = String(s).toLowerCase().replace(/_/g, " ");
    if (/furnished or unfurnished|flexible|either/.test(t)) return "either";
    if (/part/.test(t)) return "part";
    if (/unfurnished/.test(t)) return "unfurnished";
    if (/furnished/.test(t)) return "furnished";
    return null;
  }
  function letType(s) {
    if (!s) return null;
    const t = String(s).toLowerCase();
    if (/licen[cs]e/.test(t)) return "licence";
    if (/corporate/.test(t)) return "corporate";
    if (/short/.test(t)) return "short_let";
    if (/flexible/.test(t)) return "flexible";
    if (/long/.test(t)) return "periodic";
    return null;
  }
  function propertyType(s) {
    if (!s) return null;
    const t = String(s).toLowerCase();
    if (/semi[\s-]?detached/.test(t)) return "semi_detached";
    if (/detached/.test(t)) return "detached";
    if (/terrace|mews/.test(t)) return "terraced";
    if (/maisonette|duplex/.test(t)) return "maisonette";
    if (/flat|apartment|penthouse|studio/.test(t)) return "flat";
    if (/house|bungalow|cottage/.test(t)) return "house";
    return null;
  }
  const text = (html) =>
    String(html ?? "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|li|div)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&#39;|&rsquo;/g, "’").replace(/&quot;/g, '"').replace(/&pound;/g, "£")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s*\n\s*\n+/g, "\n\n")
      .trim()
      .slice(0, 2500) || null;
  const sqm = (sqft) => (sqft ? Math.round(sqft * 0.092903) : null);
  const num = (s) => (s == null || s === "" ? null : Number(String(s).replace(/[£,\s]/g, "")) || null);
  const uniq = (xs) => [...new Set(xs.filter(Boolean))];

  const base = {
    portal: null, beds: null, baths: null, sizeSqm: null, furnished: null, availableFrom: null,
    letType: null, minTermMonths: null, deposit: null, agent: null, propertyType: null,
    description: null, keyFeatures: [], photos: [], floorplans: [], epc: null, letAgreed: null,
  };

  // Rightmove: window.__PAGE_MODEL.data is a flattened array; objects map keys to indices.
  if (/rightmove\.co\.uk$/.test(host)) {
    const arr = JSON.parse(win.__PAGE_MODEL.data);
    const memo = new Map();
    const R = (i) => {
      if (typeof i !== "number" || i < 0) return null;
      if (memo.has(i)) return memo.get(i);
      const v = arr[i];
      let out;
      if (Array.isArray(v)) { out = []; memo.set(i, out); for (const x of v) out.push(R(x)); }
      else if (v && typeof v === "object") { out = {}; memo.set(i, out); for (const [k, x] of Object.entries(v)) out[k] = R(x); }
      else { out = v; memo.set(i, out); }
      return out;
    };
    const p = R(0).propertyData;
    const l = p.lettings ?? {};
    const size = (p.sizings ?? []).find((s) => /sqm|m²/i.test(s.unit ?? "")) ?? null;
    const sizeFt = (p.sizings ?? []).find((s) => /sqft|ft/i.test(s.unit ?? "")) ?? null;
    return {
      ...base,
      portal: "rightmove",
      beds: p.bedrooms ?? null,
      baths: p.bathrooms ?? null,
      sizeSqm: size ? Math.round(size.minimumSize ?? size.maximumSize) : sqm(sizeFt?.minimumSize ?? sizeFt?.maximumSize),
      furnished: furnished(l.furnishType),
      availableFrom: isoDate(l.letAvailableDate),
      letType: letType(l.letType),
      minTermMonths: l.minimumTermInMonths ?? null,
      deposit: num(l.deposit),
      agent: p.customer?.branchDisplayName ?? null,
      propertyType: propertyType(p.propertySubType),
      description: text(p.text?.description),
      keyFeatures: (p.keyFeatures ?? []).slice(0, 12),
      photos: uniq((p.images ?? []).map((i) => i.url)).slice(0, 20),
      floorplans: uniq((p.floorplans ?? []).map((f) => f.url)).slice(0, 4),
      epc: null,
      letAgreed: /let agreed|let_agreed/i.test(JSON.stringify([p.status ?? null, p.tags ?? null, p.misInfo ?? null])) || null,
    };
  }

  // OnTheMarket: Next.js state.
  if (/onthemarket\.com$/.test(host)) {
    const p = win.__NEXT_DATA__.props.pageProps.initialReduxState.property;
    const items = (p.lettingDetails?.items ?? []).map(String);
    const all = items.join(" | ");
    const avail = items.find((s) => /available/i.test(s));
    const dep = items.find((s) => /deposit/i.test(s));
    return {
      ...base,
      portal: "onthemarket",
      beds: p.bedrooms ?? null,
      baths: p.bathrooms ?? null,
      sizeSqm: p.minimumAreaSqM ?? sqm(p.minimumAreaSqFt),
      furnished: furnished(items.find((s) => /furnish/i.test(s))),
      availableFrom: avail ? isoDate(avail.replace(/^.*?available\s*(from)?:?\s*/i, "")) : null,
      letType: letType(all),
      deposit: dep ? num((/£\s?([\d,]+)/.exec(dep) ?? [])[1]) : null,
      agent: p.agent?.name ?? null,
      propertyType: propertyType(p.propertyTitle),
      description: text(p.description),
      keyFeatures: (p.features ?? []).map((f) => f.feature).filter(Boolean).slice(0, 12),
      photos: uniq((p.images ?? []).map((i) => i.largeUrl ?? (i.prefix ? `${i.prefix}-1024x1024.${i.ext ?? "jpg"}` : null))).slice(0, 20),
      floorplans: uniq((p.floorplans ?? []).map((f) => f.largeUrl ?? f.url)).slice(0, 4),
      epc: p.epc?.rating ?? null,
      letAgreed: /let agreed|under offer/i.test(JSON.stringify([p.propertyLabels ?? null, p.priceQualifier ?? null])) || null,
    };
  }

  // Zoopla: values in the streamed page data (self.__next_f), the rest from visible text.
  if (/zoopla\.co\.uk$/.test(host)) {
    const flight = [...doc.scripts].map((s) => s.textContent).filter((t) => /self\.__next_f/.test(t)).join("");
    const grab = (key) => {
      const m = new RegExp(`${key}\\\\?"\\s*:\\s*\\\\?"?([^,\\\\"}]+)`).exec(flight);
      return m ? m[1] : null;
    };
    const main = doc.querySelector("main")?.innerText ?? "";
    const ld = [...doc.querySelectorAll('script[type="application/ld+json"]')]
      .map((s) => { try { return JSON.parse(s.textContent); } catch { return null; } })
      .find((x) => x && x["@type"] === "RealEstateListing");
    // Images as { caption, filename } in listing order; the floor plan is captioned "Floorplan".
    const imgs = [...flight.matchAll(/caption\\*"\s*:\s*(?:\\*"([^"\\]*)\\*"|null)\s*,\s*\\*"filename\\*"\s*:\s*\\*"([0-9a-f]{40}\.\w+)/g)]
      .map((m) => ({ caption: m[1] ?? "", file: m[2] }));
    const isPlan = (i) => /floor\s*plan/i.test(i.caption);
    const avail = /Available (from [^\n]+|immediately|now)/i.exec(main);
    return {
      ...base,
      portal: "zoopla",
      beds: num(grab("numBeds")),
      baths: num(grab("numBaths")),
      sizeSqm: sqm(num(grab("sizeSqft"))),
      furnished: furnished(grab("furnishedState")),
      availableFrom: avail ? isoDate(avail[1].replace(/^from\s+/i, "")) : null,
      letType: letType((/\n(Short let|Long let|Short term|Long term)[^\n]*/i.exec(main) ?? [])[0]),
      deposit: num((/Deposit\s*\n\s*£([\d,]+)/.exec(main) ?? [])[1]),
      agent: (/\n([^\n]+)\n+View agent properties/.exec(main) ?? [])[1]?.trim() ?? null,
      propertyType: propertyType((/\d+\s*bed\s+([^\n]+?)\s+to rent/i.exec(doc.title) ?? [])[1]),
      description: text(ld?.description),
      keyFeatures: [],
      photos: uniq(imgs.filter((i) => !isPlan(i)).map((i) => `https://lid.zoocdn.com/u/1024/768/${i.file}`)).slice(0, 20),
      floorplans: uniq(imgs.filter(isPlan).map((i) => `https://lc.zoocdn.com/${i.file}`)).slice(0, 4),
      epc: null,
      letAgreed: /^(rented|let_agreed|let)$/i.test(grab("listingStatus") ?? "") || /\n(Let agreed|Let)\n/.test(`\n${main}`) || null,
    };
  }

  return { ...base, error: `unknown portal: ${host}` };
}

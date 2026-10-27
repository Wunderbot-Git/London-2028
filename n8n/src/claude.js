// Claude API requests (spec §5.3 nodes 4 and 8, §6.3). n8n sends them with an HTTP Request node,
// so this builds plain Messages API bodies and reads the answers.
// Both calls use structured outputs (output_config.format), so the text block is valid JSON.

const nullable = (type, extra = {}) => ({ type: [type, "null"], ...extra });

export const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    listings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          url: nullable("string"),
          sourceId: nullable("string"),
          address: nullable("string"),
          postcode: nullable("string"),
          area: nullable("string"),
          price: nullable("number"),
          pricePeriod: nullable("string", { enum: ["month", "week", null] }),
          billsIncluded: nullable("boolean"),
          letType: { type: "string", enum: ["short_let", "flexible", "periodic", "corporate", "licence", "unknown"] },
          minTermMonths: nullable("integer"),
          maxTermMonths: nullable("integer"),
          availableFrom: nullable("string"),
          beds: nullable("integer"),
          baths: nullable("integer"),
          furnished: { type: "string", enum: ["furnished", "part", "unfurnished", "either", "unknown"] },
          garden: nullable("boolean"),
          parking: nullable("boolean"),
          epc: nullable("string"),
          highlight: nullable("string"),
          photos: { type: "array", items: { type: "string" } },
        },
        required: [
          "url", "sourceId", "address", "postcode", "area", "price", "pricePeriod", "billsIncluded",
          "letType", "minTermMonths", "maxTermMonths", "availableFrom", "beds", "baths", "furnished",
          "garden", "parking", "epc", "highlight", "photos",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["listings"],
  additionalProperties: false,
};

export const PREDICTION_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "integer", enum: [1, 2, 3, 4, 5] },
    rationale: { type: "string" },
  },
  required: ["score", "rationale"],
  additionalProperties: false,
};

// Mail text is passed in full; this only guards against a runaway newsletter.
export const MAX_MAIL_CHARS = 120000;

const EXTRACTION_SYSTEM = `You extract rental listings from property alert emails (UK portals and letting agents).
The email text marks links as [[LINK:url]] and images as [[IMG:src]].
Return every distinct property the email advertises. Use null for anything the email does not state; never guess.
- url: the link that opens the listing (prefer the portal listing URL over tracking links if both appear).
- sourceId: the portal's numeric listing ID if visible in the URL, else null.
- price/pricePeriod: the rent as stated, with "week" for pw/per week and "month" for pcm/per month.
- letType: short_let, flexible, periodic (ordinary long let), corporate, licence, or unknown.
- availableFrom: ISO date (YYYY-MM-DD); "available now" means today's date, given below.
- highlight: one short German phrase for the most notable feature (e.g. "Garten nach Süden"), or null.
- photos: image URLs that belong to the listing (no logos or icons).`;

export function extractionRequest(mail, settings, today = new Date()) {
  const text = mail.text.length > MAX_MAIL_CHARS ? mail.text.slice(0, MAX_MAIL_CHARS) : mail.text;
  return {
    model: settings.claudeModel,
    max_tokens: 16000,
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: EXTRACTION_SCHEMA } },
    system: EXTRACTION_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Today: ${today.toISOString().slice(0, 10)}\nFrom: ${mail.from}\nSubject: ${mail.subject}\n\n${text}`,
      },
    ],
  };
}

/** Parses a structured-output answer. Throws with a readable reason when there is none. */
export function readJson(body) {
  if (!body || body.type === "error" || body.error) {
    throw new Error(`Claude API error: ${body?.error?.message ?? JSON.stringify(body).slice(0, 300)}`);
  }
  if (body.stop_reason === "refusal") throw new Error(`Claude declined (${body.stop_details?.category ?? "no category"})`);
  if (body.stop_reason === "max_tokens") throw new Error("Claude answer was cut off at max_tokens");
  const text = (body.content ?? []).find((b) => b.type === "text")?.text;
  if (!text) throw new Error("Claude answer has no text block");
  return JSON.parse(text);
}

const FAMILY = `Die Familie (2 Erwachsene, 2 Kinder) sucht für 6 Monate ab Januar 2028 ein möbliertes Haus oder eine Wohnung in London.
Die Kinder gehen auf die Deutsche Schule London (DSL), Douglas House, Petersham Road, Richmond TW10 7AH.
Gebiete nach Priorität: Petersham und Ham (zu Fuß zur Schule), Richmond (Bus 65/371), North Kingston und East Sheen, Wimbledon/Southfields nur zum Vergleich.
Seit Mai 2026 gibt es keine befristeten Mietverträge mehr: Short Lets, Licences, Flexible und Corporate Lets passen zur Laufzeit; reguläre unbefristete Miete ist günstiger, aber Vermieter wollen meist Langzeitmieter.`;

const SCALE = "1 = Nein, 2 = Eher nicht, 3 = Vielleicht, 4 = Interessant, 5 = Unbedingt";

/** Short listing description for prompts (also used for the few-shot examples). */
export function describe(l) {
  const c = l.commute ?? {};
  const school = [
    c.walkMin != null && `${c.walkMin} Min. zu Fuß`,
    c.transitMin != null && `${c.transitMin} Min. mit ${c.transitSummary ?? "ÖPNV"}`,
  ].filter(Boolean).join(", ") || "unbekannt";
  return [
    `Adresse: ${l.address}${l.area ? `, ${l.area}` : ""} (${l.postcode || "Postcode unbekannt"})`,
    `Miete: ${l.priceMonthly != null ? `£${l.priceMonthly} pcm` : "unbekannt"}${l.billsIncluded ? ", Nebenkosten inklusive" : ""}`,
    `Mietform: ${l.letType}${l.minTermMonths || l.maxTermMonths ? ` (${l.minTermMonths ?? "?"}–${l.maxTermMonths ?? "?"} Monate)` : ""}`,
    `Verfügbar ab: ${l.availableFrom ?? "unbekannt"}`,
    `Zimmer: ${l.beds ?? "?"} Schlafzimmer, ${l.baths ?? "?"} Bäder; Einrichtung: ${l.furnished}`,
    `Garten: ${l.garden == null ? "unbekannt" : l.garden ? "ja" : "nein"}; Parkplatz: ${l.parking == null ? "unbekannt" : l.parking ? "ja" : "nein"}`,
    `Schulweg zur DSL: ${school}`,
    l.highlight ? `Besonderheit: ${l.highlight}` : null,
    l.flags?.length ? `Hinweise: ${l.flags.join(", ")}` : null,
  ].filter(Boolean).join("\n");
}

/**
 * Prediction request (spec §6.3): listing + current profile (rules, hard filters) + few-shot
 * examples with the family's ratings. Stable parts come first so prompt caching can reuse them.
 */
export function predictionRequest(listing, context, settings) {
  const profile = context.profile;
  const criteria = context.criteria ?? {};
  const hard = { ...criteria, ...(profile?.hardFilters ?? {}) };
  const guard = [
    hard.maxPriceMonthly != null && `Budget bis £${hard.maxPriceMonthly} pcm`,
    hard.minBeds != null && `mindestens ${hard.minBeds} Schlafzimmer`,
    hard.maxCommuteMin != null && `Schulweg höchstens ${hard.maxCommuteMin} Min.`,
  ].filter(Boolean);
  const examples = (context.examples ?? [])
    .map((e, i) => `Beispiel ${i + 1} – Bewertung ${e.score}${e.tags?.length ? ` (Gründe: ${e.tags.join(", ")})` : ""}${e.notes?.length ? `; Notizen: ${e.notes.join(" / ")}` : ""}\n${describe(e.listing)}`)
    .join("\n\n");

  const system = [
    `Du schätzt ein, wie interessant ein Mietinserat für eine Familie ist. Skala: ${SCALE}.`,
    FAMILY,
    guard.length ? `Bestätigte Leitplanken: ${guard.join("; ")}.` : "Leitplanken (Budget, Zimmer, Schulweg) sind noch nicht festgelegt.",
    profile?.rules?.length
      ? `Gelernte Vorlieben (Profil v${profile.version}):\n- ${profile.rules.join("\n- ")}`
      : "Es gibt noch kein gelerntes Profil; urteile nach der Beschreibung der Familie.",
    examples ? `Bisher bewertete Inserate:\n\n${examples}` : null,
    "Antworte mit score (1–5) und rationale: ein bis zwei kurze deutsche Sätze, die das Wichtigste dafür und dagegen nennen.",
  ].filter(Boolean).join("\n\n");

  return {
    model: settings.claudeModel,
    max_tokens: 8000,
    fallbacks: "default",
    cache_control: { type: "ephemeral" },
    output_config: { effort: "medium", format: { type: "json_schema", schema: PREDICTION_SCHEMA } },
    system,
    messages: [{ role: "user", content: `Neues Inserat:\n${describe(listing)}` }],
  };
}

/** Prediction map of spec §5.4, or null when Claude gave no usable answer. */
export function readPrediction(body, profileVersion, now = new Date()) {
  const p = readJson(body);
  return {
    score: p.score,
    rationale: p.rationale,
    profileVersion: profileVersion ?? null,
    model: body.model ?? null,
    createdAt: now.toISOString(),
  };
}

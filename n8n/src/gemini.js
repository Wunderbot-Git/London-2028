// Gemini API requests (spec §5.3 nodes 4 and 8, §6.3). n8n sends them with an HTTP Request node
// to models/{model}:generateContent, so this builds plain request bodies and reads the answers.
// Every call uses structured output (responseMimeType + responseJsonSchema), so the answer text is
// valid JSON. The model is part of the URL, not the body (see build/lib.mjs).

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
          // "unknown" instead of null: enums with null are not reliably supported; readExtraction maps it back.
          pricePeriod: { type: "string", enum: ["month", "week", "unknown"] },
          billsIncluded: nullable("boolean"),
          letType: { type: "string", enum: ["short_let", "flexible", "periodic", "corporate", "licence", "unknown"] },
          minTermMonths: nullable("integer"),
          maxTermMonths: nullable("integer"),
          availableFrom: nullable("string"),
          beds: nullable("integer"),
          baths: nullable("integer"),
          furnished: { type: "string", enum: ["furnished", "part", "unfurnished", "either", "unknown"] },
          propertyType: { type: "string", enum: ["flat", "maisonette", "detached", "semi_detached", "terraced", "house", "unknown"] },
          agent: nullable("string"),
          priceReduced: nullable("boolean"),
          garden: nullable("boolean"),
          parking: nullable("boolean"),
          epc: nullable("string"),
          highlight: nullable("string"),
          photos: { type: "array", items: { type: "string" } },
        },
        required: [
          "url", "sourceId", "address", "postcode", "area", "price", "pricePeriod", "billsIncluded",
          "letType", "minTermMonths", "maxTermMonths", "availableFrom", "beds", "baths", "furnished",
          "propertyType", "agent", "priceReduced", "garden", "parking", "epc", "highlight", "photos",
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
- price/pricePeriod: the rent as stated, with "week" for pw/per week, "month" for pcm/per month, "unknown" if no period is stated.
- letType: short_let, flexible, periodic (ordinary long let), corporate, licence, or unknown.
- propertyType: flat (also apartment, penthouse, studio), maisonette, detached, semi_detached, terraced (also end of terrace, mews), house (other houses), or unknown.
- agent: the letting agent or landlord named for this listing ("Marketed by …"), else null.
- priceReduced: true if the email says the rent was reduced, else null.
- availableFrom: ISO date (YYYY-MM-DD); "available now" means today's date, given below.
- highlight: one short German phrase for the most notable feature (e.g. "Garten nach Süden"), or null.
- photos: image URLs that belong to the listing (no logos or icons).`;

/**
 * generateContent body. thinkingLevel low/medium/high works on Gemini 3.x and 4 models;
 * maxOutputTokens includes the thinking tokens, so the limits leave room for them.
 */
export function geminiRequest({ system, user, schema, thinkingLevel, maxOutputTokens }) {
  return {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: schema,
      maxOutputTokens,
      thinkingConfig: { thinkingLevel },
    },
  };
}

export function extractionRequest(mail, today = new Date()) {
  const text = mail.text.length > MAX_MAIL_CHARS ? mail.text.slice(0, MAX_MAIL_CHARS) : mail.text;
  return geminiRequest({
    system: EXTRACTION_SYSTEM,
    user: `Today: ${today.toISOString().slice(0, 10)}\nFrom: ${mail.from}\nSubject: ${mail.subject}\n\n${text}`,
    schema: EXTRACTION_SCHEMA,
    thinkingLevel: "low",
    maxOutputTokens: 16384,
  });
}

/** Text of a generateContent answer (thought parts skipped). Throws with a readable reason when there is none. */
export function readText(body) {
  if (!body || body.error) {
    throw new Error(`Gemini API error: ${body?.error?.message ?? JSON.stringify(body).slice(0, 300)}`);
  }
  if (body.promptFeedback?.blockReason) throw new Error(`Gemini blocked the request (${body.promptFeedback.blockReason})`);
  const candidate = body.candidates?.[0];
  if (!candidate) throw new Error("Gemini answer has no candidate");
  if (candidate.finishReason === "MAX_TOKENS") throw new Error("Gemini answer was cut off at maxOutputTokens");
  if (candidate.finishReason && candidate.finishReason !== "STOP") throw new Error(`Gemini stopped early (${candidate.finishReason})`);
  const text = (candidate.content?.parts ?? []).filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text).join("");
  if (!text) throw new Error("Gemini answer has no text");
  return text;
}

/** Parses a structured-output answer. */
export function readJson(body) {
  return JSON.parse(readText(body));
}

/** Extraction answer → listings in the parser's shape (pricePeriod "unknown" back to null). */
export function readExtraction(body) {
  return readJson(body).listings.map((l) => ({ ...l, pricePeriod: l.pricePeriod === "unknown" ? null : l.pricePeriod }));
}

const FAMILY = `Die Familie (2 Erwachsene, 2 Kinder) sucht für 6 Monate ab Januar 2028 ein möbliertes Haus oder eine Wohnung in London.
Die Kinder gehen auf die Deutsche Schule London (DSL), Douglas House, Petersham Road, Richmond TW10 7AH.
Gebiete nach Priorität: Petersham und Ham (zu Fuß zur Schule), Richmond (Bus 65/371), North Kingston und East Sheen, Wimbledon/Southfields nur zum Vergleich.
Seit Mai 2026 gibt es keine befristeten Mietverträge mehr: Short Lets, Licences, Flexible und Corporate Lets passen zur Laufzeit; reguläre unbefristete Miete ist günstiger, aber Vermieter wollen meist Langzeitmieter.`;

const PROPERTY_LABEL = {
  flat: "Wohnung", maisonette: "Maisonette", detached: "Freistehendes Haus", semi_detached: "Doppelhaushälfte",
  terraced: "Reihenhaus", house: "Haus",
};

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
    PROPERTY_LABEL[l.propertyType] ? `Objekt: ${PROPERTY_LABEL[l.propertyType]}` : null,
    `Miete: ${l.priceMonthly != null ? `£${l.priceMonthly} pcm` : "unbekannt"}${l.billsIncluded ? ", Nebenkosten inklusive" : ""}${l.priceReduced ? " (gesenkt)" : ""}`,
    `Mietform: ${l.letType}${l.minTermMonths || l.maxTermMonths ? ` (${l.minTermMonths ?? "?"}–${l.maxTermMonths ?? "?"} Monate)` : ""}`,
    `Verfügbar ab: ${l.availableFrom ?? "unbekannt"}`,
    `Zimmer: ${l.beds ?? "?"} Schlafzimmer, ${l.baths ?? "?"} Bäder; Einrichtung: ${l.furnished}`,
    `Garten: ${l.garden == null ? "unbekannt" : l.garden ? "ja" : "nein"}; Parkplatz: ${l.parking == null ? "unbekannt" : l.parking ? "ja" : "nein"}`,
    `Schulweg zur DSL: ${school}`,
    l.sizeSqm ? `Größe: ${l.sizeSqm} m²` : null,
    l.keyFeatures?.length ? `Merkmale laut Inserat: ${l.keyFeatures.slice(0, 8).join("; ")}` : null,
    l.description ? `Beschreibung (Auszug): ${l.description.replace(/\s+/g, " ").slice(0, 600)}` : null,
    l.letAgreed ? "Laut Portal bereits vermietet." : null,
    l.highlight ? `Besonderheit: ${l.highlight}` : null,
    l.flags?.length ? `Hinweise: ${l.flags.join(", ")}` : null,
  ].filter(Boolean).join("\n");
}

/**
 * What the model knows when judging (spec §6.3): family, confirmed guard rails, profile rules and
 * few-shot examples with the family's ratings. Shared by the prediction and the weekly backtest.
 */
export function judgeSystem(context) {
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

  return [
    `Du schätzt ein, wie interessant ein Mietinserat für eine Familie ist. Skala: ${SCALE}.`,
    FAMILY,
    guard.length ? `Bestätigte Leitplanken: ${guard.join("; ")}.` : "Leitplanken (Budget, Zimmer, Schulweg) sind noch nicht festgelegt.",
    profile?.rules?.length
      ? `Gelernte Vorlieben (Profil v${profile.version}):\n- ${profile.rules.join("\n- ")}`
      : "Es gibt noch kein gelerntes Profil; urteile nach der Beschreibung der Familie.",
    examples ? `Bisher bewertete Inserate:\n\n${examples}` : null,
  ].filter(Boolean).join("\n\n");
}

/** Prediction request for one new listing. The system part comes first and stays stable, so Gemini's implicit caching can reuse it. */
export function predictionRequest(listing, context) {
  return geminiRequest({
    system: `${judgeSystem(context)}\n\nAntworte mit score (1–5) und rationale: ein bis zwei kurze deutsche Sätze, die das Wichtigste dafür und dagegen nennen.`,
    user: `Neues Inserat:\n${describe(listing)}`,
    schema: PREDICTION_SCHEMA,
    thinkingLevel: "medium",
    maxOutputTokens: 8192,
  });
}

/** Prediction map of spec §5.4; throws when Gemini gave no usable answer. */
export function readPrediction(body, profileVersion, now = new Date()) {
  const p = readJson(body);
  return {
    score: p.score,
    rationale: p.rationale,
    profileVersion: profileVersion ?? null,
    model: body.modelVersion ?? null,
    createdAt: now.toISOString(),
  };
}

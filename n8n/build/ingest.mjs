// london-ingest (spec §5.3): alert mails in the AgentMail inbox → listings in Firestore.
import { AGENTMAIL, FIRESTORE, GEMINI, GEMINI_URL, GOOGLE, TFL, workflowBuilder } from "./lib.mjs";
import { notNullQuery } from "../src/firestore.js";

// Settings the user edits once after import.
const SETTINGS = {
  projectId: "DEIN-GCP-PROJEKT",
  geminiModel: "gemini-3.8-flash",
  schoolPostcode: "TW107AH",
  agentmailInbox: "london@agentmail.to",
};

const INBOX = "https://api.agentmail.to/v0/inboxes/{{ encodeURIComponent($('Settings').first().json.agentmailInbox) }}/messages";

export function ingest() {
  const { node, connect, chain, codeNode, http, finish } = workflowBuilder();

  // ---------------------------------------------------------------------------------------------
  // 1 · Poll the inbox; stop early when nothing is new

  const trigger = node("Every 15 minutes", "n8n-nodes-base.scheduleTrigger", 1.2, {
    rule: { interval: [{ field: "minutes", minutesInterval: 15 }] },
  });

  const settings = node(
    "Settings",
    "n8n-nodes-base.set",
    3.4,
    { mode: "raw", jsonOutput: JSON.stringify(SETTINGS, null, 2), options: {} },
    { executeOnce: true, notes: "Einmal nach dem Import anpassen: GCP-Projekt-ID. agentmailInbox ist das Postfach der Suchalerts." },
  );

  // Last 7 days, so a few days of downtime lose nothing; processed mails carry a label.
  const listMails = http("List mails", {
    url: `=${INBOX}`,
    query: [
      { name: "limit", value: "100" },
      { name: "after", value: "={{ $now.minus({ days: 7 }).toUTC().toISO() }}" },
    ],
    credentials: AGENTMAIL,
    auth: "generic",
  });

  const pickMails = codeNode("Pick new mails", ["agentmail"], `
  const r = $input.first().json;
  if (r.statusCode !== 200) throw new Error(\`AgentMail list: \${r.statusCode} \${JSON.stringify(r.body).slice(0, 300)}\`);
  return newMessageIds(r.body).map((messageId) => ({ json: { messageId } }));
  `);

  const getMail = http("Get mail", {
    url: `=${INBOX}/{{ encodeURIComponent($json.messageId) }}`,
    credentials: AGENTMAIL,
    auth: "generic",
  });

  const loadProfile = http(
    "Load profile",
    {
      method: "POST",
      url: `${FIRESTORE}:runQuery`,
      body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "profiles" }], orderBy: [{ field: { fieldPath: "version" }, direction: "DESCENDING" }], limit: 1 } }),
      credentials: GOOGLE,
      auth: "predefined",
    },
    { executeOnce: true },
  );

  const planContext = codeNode("Plan context fetch", ["firestore", "context"], `
  const s = $('Settings').first().json;
  const r = $input.first().json;
  if (r.statusCode !== 200) throw new Error(\`Firestore profiles: \${r.statusCode} \${JSON.stringify(r.body).slice(0, 300)}\`);
  const profile = queryDocs(r.body)[0] ?? null;
  return [{ json: { profile, batchGet: contextBatchGet(s.projectId, profile) } }];
  `);

  const fetchContext = http("Fetch context", {
    method: "POST",
    url: `${FIRESTORE}:batchGet`,
    body: "={{ JSON.stringify($json.batchGet) }}",
    credentials: GOOGLE,
    auth: "predefined",
  });

  const context = codeNode("Context", ["firestore", "context"], `
  const plan = $('Plan context fetch').first().json;
  const r = $input.first().json;
  if (r.statusCode !== 200) throw new Error(\`Firestore batchGet: \${r.statusCode} \${JSON.stringify(r.body).slice(0, 300)}\`);
  const { criteria, examples } = readContext(r.body, plan.profile);
  return [{ json: { criteria, examples, profile: plan.profile } }];
  `);

  chain(trigger, settings, listMails, pickMails, getMail, loadProfile, planContext, fetchContext, context);

  // ---------------------------------------------------------------------------------------------
  // 2 · Parse mails, Gemini fallback for what the parser cannot read

  const parse = codeNode("Parse alert mails", ["agentmail", "parse"], `
  return $('Get mail').all().map((item) => {
    const r = item.json;
    if (r.statusCode !== 200) throw new Error(\`AgentMail get: \${r.statusCode} \${JSON.stringify(r.body).slice(0, 300)}\`);
    return { json: parseMail(toMail(r.body)) };
  });
  `);

  const needsGemini = node("Needs Gemini?", "n8n-nodes-base.if", 2.2, {
    conditions: {
      options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 2 },
      conditions: [
        {
          id: "needs-llm",
          leftValue: "={{ $json.needsLlm }}",
          rightValue: "",
          operator: { type: "boolean", operation: "true", singleValue: true },
        },
      ],
      combinator: "and",
    },
    options: {},
  });

  const buildExtraction = codeNode("Build extraction request", ["gemini"], `
  return $input.all().map((item) => ({ json: { ...item.json, geminiRequest: extractionRequest(item.json) } }));
  `);

  const geminiExtract = http("Gemini extract", {
    method: "POST",
    url: GEMINI_URL,
    body: "={{ JSON.stringify($json.geminiRequest) }}",
    credentials: GEMINI,
    auth: "generic",
  });

  const readExtraction = codeNode("Read extraction", ["parse", "normalize", "gemini"], `
  return $input.all().map((item, i) => {
    const { geminiRequest, text, ...mail } = $('Build extraction request').itemMatching(i).json;
    try {
      return { json: { ...mail, extracted: readExtraction(item.json.body), extractedBy: 'gemini' } };
    } catch (e) {
      // Keep what the parser read completely; the error stays visible in the execution.
      const extracted = mail.listings.filter(isComplete).map((l) => fromParser(l));
      return { json: { ...mail, extracted, extractedBy: 'parser', extractionError: e.message } };
    }
  });
  `);

  const useParser = codeNode("Use parser results", ["normalize"], `
  return $input.all().map((item) => {
    const { text, ...mail } = item.json;
    return { json: { ...mail, extracted: mail.listings.map((l) => fromParser(l)), extractedBy: 'parser' } };
  });
  `);

  chain(context, parse, needsGemini);

  // Label the mails as processed. This branch sits below the main path, so with execution order
  // v1 it runs only after every listing of the run is saved; if anything fails, the mails stay
  // unlabelled and the next poll tries again (saving is idempotent). A mail whose Gemini
  // extraction failed is left unlabelled too, so it is read again on the next poll (the list
  // covers 7 days, so a mail Gemini never reads drops out after a week).
  const pickProcessed = codeNode("Pick processed mails", [], `
  const failed = new Set();
  if ($('Read extraction').isExecuted) {
    for (const item of $('Read extraction').all()) if (item.json.extractionError) failed.add(item.json.messageId);
  }
  return $input.all()
    .filter((item) => !failed.has(item.json.messageId))
    .map((item) => ({ json: { messageId: item.json.messageId } }));
  `);
  const markMails = http("Mark mails processed", {
    method: "PATCH",
    url: `=${INBOX}/{{ encodeURIComponent($json.messageId) }}`,
    body: '={{ JSON.stringify({ add_labels: ["london-processed"] }) }}',
    credentials: AGENTMAIL,
    auth: "generic",
  });
  chain(parse, pickProcessed, markMails);
  connect(needsGemini, buildExtraction, 0);
  connect(needsGemini, useParser, 1);
  chain(buildExtraction, geminiExtract, readExtraction);

  // ---------------------------------------------------------------------------------------------
  // 3 · Normalise and deduplicate

  const normalizeNode = codeNode("Normalize listings", ["parse", "normalize", "firestore"], `
  const ctx = $('Context').first().json;
  const s = $('Settings').first().json;
  const seen = new Set();
  const firstByFingerprint = new Map(); // same house from two portals in one run
  const out = [];
  for (const item of $input.all()) {
    const mail = item.json;
    for (const x of mail.extracted ?? []) {
      const u = x.url ? unwrapUrl(x.url) : { source: null, sourceId: null };
      const l = normalize(
        { ...x, url: u.sourceId ? u.url : x.url, sourceId: x.sourceId ?? u.sourceId },
        { source: u.source ?? mail.source, messageId: mail.messageId, extractedBy: mail.extractedBy, criteria: ctx.criteria },
      );
      // Without price and bedrooms there is nothing to review.
      if (l.priceMonthly == null && l.beds == null) continue;
      if (seen.has(l.id)) continue;
      seen.add(l.id);
      const first = l.fingerprint ? firstByFingerprint.get(l.fingerprint) : null;
      if (first && first.source !== l.source && samePrice(first.priceMonthly, l.priceMonthly)) l._dupInRun = first.id;
      else if (l.fingerprint && !first) firstByFingerprint.set(l.fingerprint, l);
      const district = l.postcode.split(' ')[0];
      l._geoUrl = l._postcodeFull
        ? 'https://api.postcodes.io/postcodes/' + encodeURIComponent(l._postcodeFull)
        : 'https://api.postcodes.io/outcodes/' + encodeURIComponent(district || 'unbekannt');
      l._tflDate = nextMonday();
      l._dupQuery = equalityQuery('listings', 'fingerprint', l.fingerprint);
      out.push({ json: l });
    }
  }
  return out;
  `);

  const lookup = http("Lookup by id", {
    url: `${FIRESTORE}/listings/{{ $json.id }}`,
    credentials: GOOGLE,
    auth: "predefined",
  });

  const findDup = http("Find duplicate", {
    method: "POST",
    url: `${FIRESTORE}:runQuery`,
    body: "={{ JSON.stringify($('Normalize listings').item.json._dupQuery) }}",
    credentials: GOOGLE,
    auth: "predefined",
  });

  const classify = codeNode("Classify", ["firestore", "normalize"], `
  const originalOf = new Map(); // listing id → id of the original it duplicates (this run)
  return $input.all().map((dup, i) => {
    const l = $('Normalize listings').itemMatching(i).json;
    const look = $('Lookup by id').itemMatching(i).json;
    if (look.statusCode === 200) return { json: { ...l, _kind: 'seen' } };
    if (look.statusCode !== 404) throw new Error(\`Firestore lookup \${l.id}: \${look.statusCode} \${JSON.stringify(look.body).slice(0, 300)}\`);
    if (dup.json.statusCode !== 200) throw new Error(\`Firestore duplicate query \${l.id}: \${dup.json.statusCode}\`);
    // An empty fingerprint (no street or district) never matches; rents far apart mean two different homes.
    const matches = l.fingerprint
      ? queryDocs(dup.json.body).filter((d) => d.id !== l.id && samePrice(d.priceMonthly, l.priceMonthly))
      : [];
    const original = matches.find((d) => !d.duplicateOf) ?? matches[0];
    if (original) {
      const id = original.duplicateOf ?? original.id;
      originalOf.set(l.id, id);
      return { json: { ...l, _kind: 'duplicate', duplicateOf: id, _original: original } };
    }
    if (l._dupInRun) {
      const id = originalOf.get(l._dupInRun) ?? l._dupInRun;
      originalOf.set(l.id, id);
      return { json: { ...l, _kind: 'duplicate', duplicateOf: id } };
    }
    return { json: { ...l, _kind: 'new' } };
  });
  `);

  const kindRule = (key) => ({
    conditions: {
      options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 2 },
      conditions: [
        {
          id: `kind-${key}`,
          leftValue: "={{ $json._kind }}",
          rightValue: key,
          operator: { type: "string", operation: "equals" },
        },
      ],
      combinator: "and",
    },
    renameOutput: true,
    outputKey: key,
  });

  const route = node("Route by kind", "n8n-nodes-base.switch", 3.2, {
    rules: { values: [kindRule("new"), kindRule("duplicate"), kindRule("seen")] },
    options: {},
  });

  connect(readExtraction, normalizeNode);
  connect(useParser, normalizeNode);
  chain(normalizeNode, lookup, findDup, classify, route);

  // ---------------------------------------------------------------------------------------------
  // 4 · Known listing: only lastSeenAt changes

  const touch = http("Touch lastSeenAt", {
    method: "PATCH",
    url: `${FIRESTORE}/listings/{{ $json.id }}?updateMask.fieldPaths=lastSeenAt`,
    body: "={{ JSON.stringify({ fields: { lastSeenAt: { timestampValue: $now.toISO() } } }) }}",
    credentials: GOOGLE,
    auth: "predefined",
  });
  connect(route, touch, 2);

  // ---------------------------------------------------------------------------------------------
  // 5 · Duplicate of a listing from another portal: stored archived, no TfL/Gemini calls

  const buildDup = codeNode("Build duplicate doc", ["firestore", "doc"], `
  return $input.all().map((item) => {
    const l = item.json;
    const o = l._original ?? {};
    return { json: listingDoc(l, { lat: o.lat ?? null, lng: o.lng ?? null, commute: o.commute ?? null }) };
  });
  `);
  connect(route, buildDup, 1);

  // ---------------------------------------------------------------------------------------------
  // 6 · New listing: geocode, school run, prediction

  const geocodeNode = http("Geocode", { url: "={{ $json._geoUrl }}" });

  const planCommute = codeNode("Plan commute", ["commute"], `
  return $input.all().map((geo, i) => {
    const l = $('Route by kind').itemMatching(i).json;
    const g = geo.json.statusCode === 200 ? geocode(geo.json.body) : null;
    // TfL takes "lat,lng" or a full postcode without spaces.
    const from = g ? \`\${g.lat},\${g.lng}\` : l._postcodeFull ? l._postcodeFull.replace(/\\s/g, '') : 'unbekannt';
    return { json: { ...l, _lat: g?.lat ?? null, _lng: g?.lng ?? null, _geoApprox: !!g?.approx, _from: from } };
  });
  `);

  const tflQuery = (mode) => [
    { name: "mode", value: mode },
    { name: "date", value: "={{ $('Plan commute').item.json._tflDate }}" },
    { name: "time", value: "0815" },
    { name: "timeIs", value: "Arriving" },
  ];
  const tflUrl = `=https://api.tfl.gov.uk/Journey/JourneyResults/{{ $('Plan commute').item.json._from }}/to/{{ $('Settings').first().json.schoolPostcode }}`;

  const tflWalk = http("TfL walking", { url: tflUrl, query: tflQuery("walking"), credentials: TFL, auth: "generic" });
  const tflTransit = http("TfL transit", {
    url: tflUrl,
    query: tflQuery("bus,tube,overground,national-rail,elizabeth-line,dlr,tram,walking"),
    credentials: TFL,
    auth: "generic",
  });

  const predictRequest = codeNode("Build prediction request", ["normalize", "commute", "gemini"], `
  const ctx = $('Context').first().json;
  return $input.all().map((transit, i) => {
    const l = $('Plan commute').itemMatching(i).json;
    const c = commute($('TfL walking').itemMatching(i).json.body, transit.json.body);
    const flags = [...l.flags, ...commuteFlags(c, ctx.criteria), ...(l._geoApprox ? ['commute_approx'] : [])];
    const listing = { ...l, commute: c, flags };
    return { json: { ...listing, _geminiRequest: predictionRequest(listing, ctx) } };
  });
  `);

  const geminiPredict = http("Gemini predict", {
    method: "POST",
    url: GEMINI_URL,
    body: "={{ JSON.stringify($json._geminiRequest) }}",
    credentials: GEMINI,
    auth: "generic",
  });

  const buildDoc = codeNode("Build listing doc", ["firestore", "gemini", "doc"], `
  const ctx = $('Context').first().json;
  return $input.all().map((item, i) => {
    const l = $('Build prediction request').itemMatching(i).json;
    let prediction = null;
    let predictionError = null;
    try {
      prediction = readPrediction(item.json.body, ctx.profile?.version);
    } catch (e) {
      predictionError = e.message; // listing is stored anyway; the weekly batch treats it as unsure
    }
    return { json: listingDoc(l, { lat: l._lat ?? null, lng: l._lng ?? null, commute: l.commute, prediction, predictionError }) };
  });
  `);

  connect(route, geocodeNode, 0);
  chain(geocodeNode, planCommute, tflWalk, tflTransit, predictRequest, geminiPredict, buildDoc);

  // ---------------------------------------------------------------------------------------------
  // 7 · Save, then (phase 2 only) notify

  const save = node(
    "Save listing",
    "n8n-nodes-base.httpRequest",
    4.2,
    {
      method: "PATCH",
      url: `${FIRESTORE}/listings/{{ $json.id }}`,
      authentication: "predefinedCredentialType",
      nodeCredentialType: "googleApi",
      sendBody: true,
      specifyBody: "json",
      jsonBody: "={{ JSON.stringify({ fields: $json.fields }) }}",
      options: {},
    },
    { credentials: GOOGLE },
  );
  connect(buildDoc, save);
  connect(buildDup, save);

  const notifyCheck = node("Hunt phase and score ≥ 4?", "n8n-nodes-base.if", 2.2, {
    conditions: {
      options: { caseSensitive: true, leftValue: "", typeValidation: "loose", version: 2 },
      conditions: [
        {
          id: "notify",
          leftValue:
            "={{ $('Context').first().json.criteria.phase === 'hunt' && !$json.fields?.duplicateOf?.stringValue && Number($json.fields?.prediction?.mapValue?.fields?.score?.integerValue ?? 0) >= 4 }}",
          rightValue: "",
          operator: { type: "boolean", operation: "true", singleValue: true },
        },
      ],
      combinator: "and",
    },
    options: {},
  });
  const notify = node(
    "Notify (channel open)",
    "n8n-nodes-base.noOp",
    1,
    {},
    { notes: "Phase 2: Sofortmeldung. Kanal ist offener Punkt 7 der Spezifikation (Push, Mail oder WhatsApp)." },
  );
  chain(save, notifyCheck);
  connect(notifyCheck, notify, 0);

  // ---------------------------------------------------------------------------------------------
  // 8 · Listings saved without a prediction (Gemini failed at the time): score them now.
  // Hangs off Context below everything else, so with execution order v1 it runs last and only in
  // runs with new mails. Only new listings carry a predictionError field (duplicates do not), so
  // one filter finds them without a composite index; up to 20 per run.

  const findUnscored = http("Find unscored", {
    method: "POST",
    url: `${FIRESTORE}:runQuery`,
    body: JSON.stringify(notNullQuery("listings", "predictionError", 20)),
    credentials: GOOGLE,
    auth: "predefined",
  });

  const planRescore = codeNode("Plan rescore", ["firestore", "gemini"], `
  const ctx = $('Context').first().json;
  const r = $input.first().json;
  if (r.statusCode !== 200) throw new Error(\`Firestore unscored: \${r.statusCode} \${JSON.stringify(r.body).slice(0, 300)}\`);
  return queryDocs(r.body).map((l) => ({ json: { id: l.id, _geminiRequest: predictionRequest(l, ctx) } }));
  `);

  const geminiRescore = http("Gemini rescore", {
    method: "POST",
    url: GEMINI_URL,
    body: "={{ JSON.stringify($json._geminiRequest) }}",
    credentials: GEMINI,
    auth: "generic",
  });

  // Failed answers are dropped here; the listing keeps its predictionError and is tried next run.
  const readRescore = codeNode("Read rescore", ["firestore", "gemini"], `
  const ctx = $('Context').first().json;
  const out = [];
  $input.all().forEach((item, i) => {
    const { id } = $('Plan rescore').itemMatching(i).json;
    try {
      const prediction = readPrediction(item.json.body, ctx.profile?.version);
      out.push({ json: { id, fields: toFields({ prediction, predictionError: null }) } });
    } catch (e) {
      // visible in the execution, nothing written
    }
  });
  return out;
  `);

  const savePrediction = node(
    "Save prediction",
    "n8n-nodes-base.httpRequest",
    4.2,
    {
      method: "PATCH",
      url: `${FIRESTORE}/listings/{{ $json.id }}?updateMask.fieldPaths=prediction&updateMask.fieldPaths=predictionError`,
      authentication: "predefinedCredentialType",
      nodeCredentialType: "googleApi",
      sendBody: true,
      specifyBody: "json",
      jsonBody: "={{ JSON.stringify({ fields: $json.fields }) }}",
      options: {},
    },
    { credentials: GOOGLE },
  );
  chain(context, findUnscored, planRescore, geminiRescore, readRescore, savePrediction);

  // ---------------------------------------------------------------------------------------------
  // Layout: left to right along the main path, branches below.

  const layout = {
    "Every 15 minutes": [0, 0], Settings: [220, 0], "List mails": [440, 0], "Pick new mails": [660, 0], "Get mail": [880, 0],
    "Pick processed mails": [1980, 480], "Mark mails processed": [2200, 480], "Load profile": [1100, 0], "Plan context fetch": [1320, 0],
    "Fetch context": [1540, 0], Context: [1760, 0], "Parse alert mails": [1980, 0], "Needs Gemini?": [2200, 0],
    "Build extraction request": [2420, -160], "Gemini extract": [2640, -160], "Read extraction": [2860, -160],
    "Use parser results": [2640, 120], "Normalize listings": [3080, 0], "Lookup by id": [3300, 0],
    "Find duplicate": [3520, 0], Classify: [3740, 0], "Route by kind": [3960, 0],
    Geocode: [4180, -200], "Plan commute": [4400, -200], "TfL walking": [4620, -200], "TfL transit": [4840, -200],
    "Build prediction request": [5060, -200], "Gemini predict": [5280, -200], "Build listing doc": [5500, -200],
    "Build duplicate doc": [5500, 40], "Touch lastSeenAt": [4180, 260],
    "Save listing": [5720, -80], "Hunt phase and score ≥ 4?": [5940, -80], "Notify (channel open)": [6160, -160],
    "Find unscored": [1980, 720], "Plan rescore": [2200, 720], "Gemini rescore": [2420, 720], "Read rescore": [2640, 720],
    "Save prediction": [2860, 720],
  };

  return finish("london-ingest", layout);
}

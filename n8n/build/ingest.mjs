// london-ingest (spec §5.3): alert mails in the AgentMail inbox → listings in Firestore.
import { AGENTMAIL, ANTHROPIC, CLAUDE_HEADERS, FIRESTORE, GOOGLE, TFL, workflowBuilder } from "./lib.mjs";

// Settings the user edits once after import.
const SETTINGS = {
  projectId: "DEIN-GCP-PROJEKT",
  claudeModel: "claude-opus-5-5",
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
  // 2 · Parse mails, Claude fallback for what the parser cannot read

  const parse = codeNode("Parse alert mails", ["agentmail", "parse"], `
  return $('Get mail').all().map((item) => {
    const r = item.json;
    if (r.statusCode !== 200) throw new Error(\`AgentMail get: \${r.statusCode} \${JSON.stringify(r.body).slice(0, 300)}\`);
    return { json: parseMail(toMail(r.body)) };
  });
  `);

  const needsClaude = node("Needs Claude?", "n8n-nodes-base.if", 2.2, {
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

  const buildExtraction = codeNode("Build extraction request", ["claude"], `
  const s = $('Settings').first().json;
  return $input.all().map((item) => ({ json: { ...item.json, claudeRequest: extractionRequest(item.json, s) } }));
  `);

  const claudeExtract = http("Claude extract", {
    method: "POST",
    url: "https://api.anthropic.com/v1/messages",
    body: "={{ JSON.stringify($json.claudeRequest) }}",
    headers: CLAUDE_HEADERS,
    credentials: ANTHROPIC,
    auth: "generic",
  });

  const readExtraction = codeNode("Read extraction", ["parse", "normalize", "claude"], `
  return $input.all().map((item, i) => {
    const { claudeRequest, text, ...mail } = $('Build extraction request').itemMatching(i).json;
    try {
      const out = readJson(item.json.body);
      return { json: { ...mail, extracted: out.listings, extractedBy: 'claude' } };
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

  chain(context, parse, needsClaude);

  // Label the mails as processed. This branch sits below the main path, so with execution order
  // v1 it runs only after every listing of the run is saved; if anything fails, the mails stay
  // unlabelled and the next poll tries again (saving is idempotent).
  const markMails = http("Mark mails processed", {
    method: "PATCH",
    url: `=${INBOX}/{{ encodeURIComponent($json.messageId) }}`,
    body: '={{ JSON.stringify({ add_labels: ["london-processed"] }) }}',
    credentials: AGENTMAIL,
    auth: "generic",
  });
  connect(parse, markMails);
  connect(needsClaude, buildExtraction, 0);
  connect(needsClaude, useParser, 1);
  chain(buildExtraction, claudeExtract, readExtraction);

  // ---------------------------------------------------------------------------------------------
  // 3 · Normalise and deduplicate

  const normalizeNode = codeNode("Normalize listings", ["parse", "normalize", "firestore"], `
  const ctx = $('Context').first().json;
  const s = $('Settings').first().json;
  const seen = new Set();
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

  const classify = codeNode("Classify", ["firestore"], `
  return $input.all().map((dup, i) => {
    const l = $('Normalize listings').itemMatching(i).json;
    const look = $('Lookup by id').itemMatching(i).json;
    if (look.statusCode === 200) return { json: { ...l, _kind: 'seen' } };
    if (look.statusCode !== 404) throw new Error(\`Firestore lookup \${l.id}: \${look.statusCode} \${JSON.stringify(look.body).slice(0, 300)}\`);
    if (dup.json.statusCode !== 200) throw new Error(\`Firestore duplicate query \${l.id}: \${dup.json.statusCode}\`);
    const matches = queryDocs(dup.json.body).filter((d) => d.id !== l.id);
    const original = matches.find((d) => !d.duplicateOf) ?? matches[0];
    if (original) return { json: { ...l, _kind: 'duplicate', duplicateOf: original.duplicateOf ?? original.id, _original: original } };
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
  // 5 · Duplicate of a listing from another portal: stored archived, no TfL/Claude calls

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

  const predictRequest = codeNode("Build prediction request", ["normalize", "commute", "claude"], `
  const s = $('Settings').first().json;
  const ctx = $('Context').first().json;
  return $input.all().map((transit, i) => {
    const l = $('Plan commute').itemMatching(i).json;
    const c = commute($('TfL walking').itemMatching(i).json.body, transit.json.body);
    const flags = [...l.flags, ...commuteFlags(c, ctx.criteria), ...(l._geoApprox ? ['commute_approx'] : [])];
    const listing = { ...l, commute: c, flags };
    return { json: { ...listing, _claudeRequest: predictionRequest(listing, ctx, s) } };
  });
  `);

  const claudePredict = http("Claude predict", {
    method: "POST",
    url: "https://api.anthropic.com/v1/messages",
    body: "={{ JSON.stringify($json._claudeRequest) }}",
    headers: CLAUDE_HEADERS,
    credentials: ANTHROPIC,
    auth: "generic",
  });

  const buildDoc = codeNode("Build listing doc", ["firestore", "claude", "doc"], `
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
  chain(geocodeNode, planCommute, tflWalk, tflTransit, predictRequest, claudePredict, buildDoc);

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
  // Layout: left to right along the main path, branches below.

  const layout = {
    "Every 15 minutes": [0, 0], Settings: [220, 0], "List mails": [440, 0], "Pick new mails": [660, 0], "Get mail": [880, 0],
    "Mark mails processed": [1980, 480], "Load profile": [1100, 0], "Plan context fetch": [1320, 0],
    "Fetch context": [1540, 0], Context: [1760, 0], "Parse alert mails": [1980, 0], "Needs Claude?": [2200, 0],
    "Build extraction request": [2420, -160], "Claude extract": [2640, -160], "Read extraction": [2860, -160],
    "Use parser results": [2640, 120], "Normalize listings": [3080, 0], "Lookup by id": [3300, 0],
    "Find duplicate": [3520, 0], Classify: [3740, 0], "Route by kind": [3960, 0],
    Geocode: [4180, -200], "Plan commute": [4400, -200], "TfL walking": [4620, -200], "TfL transit": [4840, -200],
    "Build prediction request": [5060, -200], "Claude predict": [5280, -200], "Build listing doc": [5500, -200],
    "Build duplicate doc": [5500, 40], "Touch lastSeenAt": [4180, 260],
    "Save listing": [5720, -80], "Hunt phase and score ≥ 4?": [5940, -80], "Notify (channel open)": [6160, -160],
  };

  return finish("london-ingest", layout);
}

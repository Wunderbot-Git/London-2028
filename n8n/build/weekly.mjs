// london-weekly (spec §5.3, second workflow), Sundays:
//   1. build the review batch for the coming week (§6.2), settle last week's batch and record its
//      metrics (§6.4) and the phase-2 check (§3);
//   2. notify both that the review is ready (channel still open, §8 point 7);
//   3. derive a new profile from all ratings and keep it only if the backtest improves (§6.3).
import { ANTHROPIC, CLAUDE_HEADERS, FIRESTORE, GOOGLE, ifTrue, workflowBuilder } from "./lib.mjs";

const SETTINGS = {
  projectId: "DEIN-GCP-PROJEKT",
  claudeModel: "claude-opus-5-5",
  batchSize: 12,
};

const query = (structuredQuery) => JSON.stringify({ structuredQuery });

export function weekly() {
  const { node, connect, chain, codeNode, http, finish } = workflowBuilder();

  // -------------------------------------------------------------------------------------------
  // Load everything once

  const trigger = node("Every Sunday 18:00", "n8n-nodes-base.scheduleTrigger", 1.2, {
    rule: { interval: [{ field: "cronExpression", expression: "0 18 * * 0" }] },
  });
  const settings = node(
    "Settings",
    "n8n-nodes-base.set",
    3.4,
    { mode: "raw", jsonOutput: JSON.stringify(SETTINGS, null, 2), options: {} },
    { notes: "Einmal nach dem Import anpassen: GCP-Projekt-ID. batchSize: 10–15 (Spec §6.2)." },
  );
  const firestore = (name, body) => http(name, { method: "POST", url: `${FIRESTORE}:runQuery`, body, credentials: GOOGLE, auth: "predefined" });

  const loadProfile = firestore("Load profile", query({ from: [{ collectionId: "profiles" }], orderBy: [{ field: { fieldPath: "version" }, direction: "DESCENDING" }], limit: 1 }));
  const loadBatches = firestore("Load batches", query({ from: [{ collectionId: "batches" }], orderBy: [{ field: { fieldPath: "week" }, direction: "DESCENDING" }], limit: 8 }));
  const loadRatings = firestore("Load ratings", query({ from: [{ collectionId: "ratings" }] }));
  const loadCandidates = firestore(
    "Load candidates",
    query({ from: [{ collectionId: "listings" }], where: { fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: "new" } } } }),
  );
  const loadWeek = firestore(
    "Load last 7 days",
    "={{ JSON.stringify({ structuredQuery: { from: [{ collectionId: 'listings' }], where: { fieldFilter: { field: { fieldPath: 'firstSeenAt' }, op: 'GREATER_THAN_OR_EQUAL', value: { timestampValue: $now.minus({ days: 7 }).toUTC().toISO() } } } } }) }}",
  );

  const planFetch = codeNode("Plan listing fetch", ["firestore"], `
    const s = $('Settings').first().json;
    const docs = (name) => {
      const r = $(name).first().json;
      if (r.statusCode !== 200) throw new Error(\`Firestore \${name}: \${r.statusCode} \${JSON.stringify(r.body).slice(0, 300)}\`);
      return queryDocs(r.body);
    };
    const profile = docs('Load profile')[0] ?? null;
    const batches = docs('Load batches');
    const ratings = docs('Load ratings');
    const ids = new Set([...ratings.map((r) => r.listingId), ...(batches[0]?.listingIds ?? []), ...(profile?.fewShot ?? [])]);
    const base = \`projects/\${s.projectId}/databases/(default)/documents\`;
    return [{ json: { batchGet: { documents: [\`\${base}/config/criteria\`, ...[...ids].map((id) => \`\${base}/listings/\${id}\`)] } } }];
  `);
  const fetchListings = http("Fetch listings", {
    method: "POST",
    url: `${FIRESTORE}:batchGet`,
    body: "={{ JSON.stringify($json.batchGet) }}",
    credentials: GOOGLE,
    auth: "predefined",
  });

  // -------------------------------------------------------------------------------------------
  // 1 · Batch, settle last week, metrics, phase check

  const compose = codeNode("Compose batch", ["firestore", "weekly", "claude", "profile"], `
    const s = $('Settings').first().json;
    const now = new Date();
    const docs = (name) => queryDocs($(name).first().json.body);
    const profile = docs('Load profile')[0] ?? null;
    const batches = docs('Load batches');
    const ratings = docs('Load ratings');
    const fetched = $input.first().json;
    if (fetched.statusCode !== 200) throw new Error(\`Firestore batchGet: \${fetched.statusCode}\`);
    const found = fetched.body.filter((r) => r.found).map((r) => ({ path: r.found.name, id: docId(r.found.name), ...fromFields(r.found.fields) }));
    const criteria = found.find((d) => d.path.endsWith('/config/criteria')) ?? {};
    const listingsById = Object.fromEntries(found.filter((d) => d.path.includes('/listings/')).map((d) => [d.id, d]));
    const byListing = ratingsByListing(ratings);

    const base = \`projects/\${s.projectId}/databases/(default)/documents\`;
    const week = reviewWeek(now);
    const writes = [];
    let previous = null;
    let mix = null;
    let candidates = docs('Load candidates');

    if (batches[0]?.week !== week) {
      // Last week's batch: record metrics, settle statuses, return unseen listings to the pool.
      previous = batches[0] && !batches[0].metrics ? batches[0] : null;
      if (previous) {
        previous.metrics = batchMetrics(previous, byListing, docs('Load last 7 days'));
        writes.push(updateWrite(\`\${base}/batches/\${previous.week}\`, { metrics: previous.metrics }));
        for (const { id, status } of settleBatch(previous, byListing)) {
          writes.push(updateWrite(\`\${base}/listings/\${id}\`, { status }));
          if (status === 'new' && listingsById[id]) candidates.push({ ...listingsById[id], id });
        }
      }
      const picked = selectBatch(candidates, { size: s.batchSize, seed: week });
      if (picked.length) {
        mix = Object.fromEntries(['top', 'unsure', 'atypical'].map((k) => [k, picked.filter((p) => p.why === k).length]));
        writes.push(updateWrite(\`\${base}/batches/\${week}\`, { week, listingIds: picked.map((p) => p.id), createdAt: now.toISOString(), completed: {}, mix }, { merge: false }));
        for (const p of picked) writes.push(updateWrite(\`\${base}/listings/\${p.id}\`, { status: 'queued', reviewWeek: week }));
      }
    }

    const phase = phaseCheck(batches.filter((b) => b.week !== week).map((b) => (previous && b.week === previous.week ? previous : b)));
    writes.push(updateWrite(\`\${base}/config/status\`, { ...phase, lastBatch: mix ? week : batches[0]?.week ?? null, updatedAt: now.toISOString() }, { merge: false }));

    const rated = ratedListings(byListing, listingsById);
    const update = shouldUpdate(profile, rated.length);
    return [{ json: {
      commit: { writes },
      summary: {
        week,
        batchSize: mix ? mix.top + mix.unsure + mix.atypical : 0,
        alreadyBuilt: batches[0]?.week === week,
        mix,
        previousWeek: previous?.week ?? null,
        previousMetrics: previous?.metrics ?? null,
        phase,
        phaseNow: criteria.phase ?? 'calibrate',
      },
      updateProfile: update,
      profile,
      criteria,
      rated: update ? rated : [],
      derivationRequest: update ? derivationRequest(rated, profile, criteria, s) : null,
    } }];
  `);

  const saveBatch = http("Save batch", {
    method: "POST",
    url: `${FIRESTORE}:commit`,
    body: "={{ JSON.stringify($json.commit) }}",
    credentials: GOOGLE,
    auth: "predefined",
  });
  const checkSave = codeNode("Check save", [], `
    const r = $input.first().json;
    if (r.statusCode !== 200) throw new Error(\`Firestore commit: \${r.statusCode} \${JSON.stringify(r.body).slice(0, 300)}\`);
    return [{ json: $('Compose batch').first().json.summary }];
  `);

  // -------------------------------------------------------------------------------------------
  // 2 · Notify

  const hasBatch = node("New batch?", "n8n-nodes-base.if", 2.2, ifTrue("has-batch", "$json.batchSize > 0"));
  const notify = node(
    "Notify review ready",
    "n8n-nodes-base.noOp",
    1,
    {},
    { notes: "„Review bereit“ an Philipp und Manuela. Kanal ist offener Punkt 7 der Spezifikation (Push, Mail oder WhatsApp). Das Item enthält Woche, Mischung, Kennzahlen der Vorwoche und den Stand der Phase-2-Prüfung." },
  );

  // -------------------------------------------------------------------------------------------
  // 3 · Profile update

  const update = node("Update profile?", "n8n-nodes-base.if", 2.2, ifTrue("update-profile", "$('Compose batch').first().json.updateProfile"));
  const derive = http("Claude derive profile", {
    method: "POST",
    url: "https://api.anthropic.com/v1/messages",
    body: "={{ JSON.stringify($('Compose batch').first().json.derivationRequest) }}",
    headers: CLAUDE_HEADERS,
    credentials: ANTHROPIC,
    auth: "generic",
  });
  const planBacktest = codeNode("Plan backtest", ["weekly", "claude", "profile"], `
    const s = $('Settings').first().json;
    const { rated, profile, criteria } = $('Compose batch').first().json;
    const candidate = readCandidate($input.first().json.body, rated, profile);
    const sample = backtestSample(rated, [...(profile?.fewShot ?? []), ...candidate.fewShot]);
    const context = (p) => ({ profile: p, criteria, examples: examplesFor(p?.fewShot, rated) });
    return [
      { json: { which: 'current', request: backtestRequest(sample, context(profile), s) } },
      { json: { which: 'candidate', request: backtestRequest(sample, context(candidate), s) } },
    ].map((item) => ({ json: { ...item.json, candidate, sampleIds: sample.map((x) => x.id) } }));
  `);
  const backtest = http("Claude backtest", {
    method: "POST",
    url: "https://api.anthropic.com/v1/messages",
    body: "={{ JSON.stringify($json.request) }}",
    headers: CLAUDE_HEADERS,
    credentials: ANTHROPIC,
    auth: "generic",
  });
  const decideNode = codeNode("Decide profile", ["firestore", "weekly", "claude", "profile"], `
    const s = $('Settings').first().json;
    const { rated } = $('Compose batch').first().json;
    const metrics = {};
    let candidate = null;
    $input.all().forEach((item, i) => {
      const plan = $('Plan backtest').itemMatching(i).json;
      const sample = plan.sampleIds.map((id) => rated.find((x) => x.id === id));
      metrics[plan.which] = readBacktest(item.json.body, sample);
      candidate = plan.candidate;
    });
    const verdict = decide(metrics.current, metrics.candidate);
    candidate = { ...candidate, metrics: metrics.candidate };
    const name = \`projects/\${s.projectId}/databases/(default)/documents/profiles/\${candidate.version}\`;
    return [{ json: {
      adopt: verdict.adopt,
      reason: verdict.reason,
      current: metrics.current,
      candidate,
      commit: { writes: [updateWrite(name, candidate, { merge: false })] },
    } }];
  `);
  const adopt = node("Adopt?", "n8n-nodes-base.if", 2.2, ifTrue("adopt", "$json.adopt"));
  const saveProfile = http("Save profile", {
    method: "POST",
    url: `${FIRESTORE}:commit`,
    body: "={{ JSON.stringify($json.commit) }}",
    credentials: GOOGLE,
    auth: "predefined",
  });
  const checkProfile = codeNode("Check profile save", [], `
    const r = $input.first().json;
    if (r.statusCode !== 200) throw new Error(\`Firestore commit: \${r.statusCode} \${JSON.stringify(r.body).slice(0, 300)}\`);
    const d = $('Decide profile').first().json;
    return [{ json: { saved: d.candidate.version, reason: d.reason } }];
  `);

  chain(trigger, settings, loadProfile, loadBatches, loadRatings, loadCandidates, loadWeek, planFetch, fetchListings, compose, saveBatch, checkSave, hasBatch);
  connect(hasBatch, notify, 0);
  connect(notify, update);
  connect(hasBatch, update, 1);
  connect(update, derive, 0);
  chain(derive, planBacktest, backtest, decideNode, adopt);
  connect(adopt, saveProfile, 0);
  chain(saveProfile, checkProfile);

  return finish("london-weekly", {
    "Every Sunday 18:00": [0, 0], Settings: [220, 0], "Load profile": [440, 0], "Load batches": [660, 0],
    "Load ratings": [880, 0], "Load candidates": [1100, 0], "Load last 7 days": [1320, 0],
    "Plan listing fetch": [1540, 0], "Fetch listings": [1760, 0], "Compose batch": [1980, 0],
    "Save batch": [2200, 0], "Check save": [2420, 0], "New batch?": [2640, 0], "Notify review ready": [2860, -120],
    "Update profile?": [3080, 0], "Claude derive profile": [3300, -120], "Plan backtest": [3520, -120],
    "Claude backtest": [3740, -120], "Decide profile": [3960, -120], "Adopt?": [4180, -120],
    "Save profile": [4400, -200], "Check profile save": [4620, -200],
  });
}

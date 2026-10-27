# n8n-Workflow „london-ingest“

Liest die Suchalerts aus dem Agent-Postfach, zieht die Inserate heraus, berechnet den Schulweg, lässt Claude eine Prognose abgeben und speichert alles in Firestore (Spec §5.3, Knoten 1–10).

`london-ingest.json` wird **generiert**: Die Logik der Code-Nodes liegt getestet in `src/`, `build.mjs` setzt sie in den Workflow ein. Änderungen also in `src/` oder `build.mjs` machen, dann `npm run build`, und den Workflow in n8n neu importieren.

```bash
cd n8n
npm install
npm test          # Parser, Normalisierung, Firestore-Kodierung, TfL, Claude-Requests
npm run build     # schreibt london-ingest.json
```

## Ablauf

| Spec | Node(s) | Was passiert |
|---|---|---|
| 1 | Gmail Trigger | alle 15 Min.; Mails von Rightmove, Zoopla, OpenRent oder mit Label `london-agenturen` |
| – | Settings, Load profile, Fetch context, Context | einmal pro Lauf: `config/criteria`, neuestes `profiles`-Dokument, Few-Shot-Inserate mit beiden Bewertungen |
| 2–3 | Parse alert mails | Portal am Absender erkennen, Inserate an den Links erkennen (auch hinter Tracking-Links), Preis, Zimmer, Adresse, Mietform usw. per Muster lesen |
| 4 | Needs Claude? → Claude extract | nur wenn der Parser nichts oder Unvollständiges findet, und immer bei Agentur-Mails. Claude liefert festes JSON (Structured Outputs). Scheitert der Aufruf, bleiben die vollständig geparsten Inserate erhalten und der Fehler steht in der Ausführung |
| 5 | Normalize listings | Preis auf pcm, Mietform und Einrichtung als Enum, Postcode-Sektor, Gebiet, Fingerprint, Flags (`term_too_short`, `over_budget`, `few_beds`, `periodic_risk`) |
| 6 | Lookup by id, Find duplicate, Classify, Route by kind | ID = `<quelle>-<portal-id>`. Bekannt → nur `lastSeenAt`. Gleicher Fingerprint aus anderem Portal → als Duplikat (`duplicateOf`, `status: archived`) ohne TfL/Claude. Sonst neu |
| 7 | Geocode, Plan commute, TfL walking, TfL transit | postcodes.io für die Koordinaten, TfL Journey Planner zur DSL (TW10 7AH), Ankunft Montag 08:15. Flags `too_far` (über `maxCommuteMin`) und `commute_approx` (nur Postcode-Bezirk bekannt) |
| 8 | Build prediction request, Claude predict | Profilregeln, harte Filter und Few-Shot-Beispiele → `{ score, rationale }`. Ohne Antwort wird das Inserat trotzdem gespeichert (`prediction: null`, `predictionError`) |
| 9 | Save listing | `listings/{id}` in Firestore |
| 10 | Hunt phase and score ≥ 4? → Notify | nur wenn `config/criteria.phase == "hunt"`. Der Kanal ist noch offen (Spec §8 Punkt 7); der Node ist ein Platzhalter |

TfL plant keine Autofahrten, deshalb bleibt `commute.driveMin` leer.

## Einrichtung in n8n

1. `london-ingest.json` importieren (Workflows → Import from File).
2. Im Node **Settings** `projectId` eintragen. `claudeModel` steht auf `claude-opus-5-5`.
3. Credentials anlegen und in den Nodes auswählen:

   | Name im Workflow | Typ | Inhalt |
   |---|---|---|
   | Gmail Agent-Konto | Gmail OAuth2 | das separate Agent-Postfach (offener Punkt 4) |
   | Firestore Service Account | Google Service Account | Service-Account mit Rolle *Cloud Datastore User*; „Set up for use in HTTP Request node“ an, Scope `https://www.googleapis.com/auth/datastore` |
   | Anthropic API key | Header Auth | Name `x-api-key`, Wert = API-Key |
   | TfL app_key | Query Auth | Name `app_key`, Wert = Key von api-portal.tfl.gov.uk |

4. In Firestore `config/criteria` anlegen, mindestens `{ "phase": "calibrate" }`. Sobald die offenen Punkte 1–3 entschieden sind: `maxPriceMonthly`, `minBeds`, `maxCommuteMin`. Ab Phase 2 `phase` auf `"hunt"` setzen.
5. Agentur-Newsletter im Agent-Postfach per Filter mit dem Label `london-agenturen` versehen.
6. Workflow aktivieren.

## Claude

- Modell aus den Settings (Standard `claude-opus-5-5`), Structured Outputs über `output_config.format`, also immer gültiges JSON.
- Extraktion mit `effort: low`, Prognose mit `effort: medium`.
- `fallbacks: "default"` (Beta `server-side-fallback-2026-07-01`): Lehnt der Sicherheitsfilter eine Anfrage ab, beantwortet sie die API serverseitig mit einem Ersatzmodell, statt abzubrechen.
- Kosten bei 50–150 Inseraten pro Woche: grob unter 2 USD pro Woche (Prognose ≈ 2–4 K Tokens je Inserat, Extraktion nur für Agentur-Mails und Parser-Lücken).

## Tests

- `npm test`: Unit-Tests der Logik in `src/` mit **synthetischen** Alert-Mails (`test/fixtures/`). Echte Mails gibt es noch nicht (Spec §9 Schritt 2). Sobald welche ankommen, anonymisierte Kopien als Fixtures ablegen und `src/parse.js` daran nachschärfen.
- `test/e2e/run.mjs`: führt den gebauten Workflow in einem echten n8n aus, mit Mock-Servern für Firestore, Claude, TfL und postcodes.io. Prüft Parser-Pfad, Claude-Fallback, Duplikat, bekanntes Inserat, Prognose mit Profil und Few-Shot und die Benachrichtigung in der Jagd-Phase. Braucht ein separat installiertes n8n (Node 24):

  ```bash
  npm i --prefix /tmp/n8n n8n
  N8N_BIN=/tmp/n8n/node_modules/n8n/bin/n8n node test/e2e/run.mjs
  ```

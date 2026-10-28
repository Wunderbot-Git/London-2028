# n8n-Workflows

| Workflow | Wann | Was |
|---|---|---|
| `london-ingest.json` | alle 15 Min. | Suchalerts → Inserate mit Schulweg und Prognose in Firestore (Spec §5.3) |
| `london-weekly.json` | sonntags 18:00 | Wochenstapel, „Review bereit“, Kennzahlen, Phase-2-Prüfung, Profil-Update (Spec §5.3, §6.2–6.4) |

Beide JSON-Dateien werden **generiert**: Die Logik der Code-Nodes liegt getestet in `src/`, die Workflows sind in `build/` beschrieben, `build.mjs` setzt beides zusammen. Änderungen also in `src/` oder `build/` machen, dann `npm run build`, und den Workflow in n8n neu importieren.

```bash
cd n8n
npm install
npm test          # Parser, Normalisierung, Firestore, TfL, Gemini-Requests, Wochenstapel, Profil
npm run build     # schreibt london-ingest.json und london-weekly.json
```

## london-ingest: Ablauf

| Spec | Node(s) | Was passiert |
|---|---|---|
| 1 | Every 15 minutes, List mails, Pick new mails, Get mail | alle 15 Min. das AgentMail-Postfach `london@agentmail.to` abfragen (Mails der letzten 7 Tage ohne Label `london-processed`) und jede neue Mail vollständig abrufen. Gibt es nichts Neues, endet der Lauf hier, ohne Firestore oder Gemini zu berühren |
| – | Settings, Load profile, Fetch context, Context | einmal pro Lauf: `config/criteria`, neuestes `profiles`-Dokument, Few-Shot-Inserate mit beiden Bewertungen |
| 2–3 | Parse alert mails | Portal am Absender erkennen, Inserate an den Links erkennen (auch hinter Tracking-Links), Preis, Zimmer, Adresse, Mietform usw. per Muster lesen |
| 4 | Needs Gemini? → Gemini extract | nur wenn der Parser nichts oder Unvollständiges findet, und immer bei Agentur-Mails. Gemini liefert festes JSON (Structured Output). Scheitert der Aufruf, bleiben die vollständig geparsten Inserate erhalten und der Fehler steht in der Ausführung |
| 5 | Normalize listings | Preis auf pcm, Mietform und Einrichtung als Enum, Postcode-Sektor, Gebiet, Fingerprint, Flags (`term_too_short`, `over_budget`, `few_beds`, `periodic_risk`) |
| 6 | Lookup by id, Find duplicate, Classify, Route by kind | ID = `<quelle>-<portal-id>`. Bekannt → nur `lastSeenAt`. Gleicher Fingerprint aus anderem Portal → als Duplikat (`duplicateOf`, `status: archived`) ohne TfL/Gemini. Sonst neu |
| 7 | Geocode, Plan commute, TfL walking, TfL transit | postcodes.io für die Koordinaten, TfL Journey Planner zur DSL (TW10 7AH), Ankunft Montag 08:15. Flags `too_far` (über `maxCommuteMin`) und `commute_approx` (nur Postcode-Bezirk bekannt) |
| 8 | Build prediction request, Gemini predict | Profilregeln, harte Filter und Few-Shot-Beispiele → `{ score, rationale }`. Ohne Antwort wird das Inserat trotzdem gespeichert (`prediction: null`, `predictionError`) |
| 9 | Save listing | `listings/{id}` in Firestore |
| 10 | Hunt phase and score ≥ 4? → Notify | nur wenn `config/criteria.phase == "hunt"`. Der Kanal ist noch offen (Spec §8 Punkt 7); der Node ist ein Platzhalter |
| – | Mark mails processed | setzt in AgentMail das Label `london-processed`. Läuft erst, wenn alle Inserate des Laufs gespeichert sind; bricht vorher etwas ab, bleiben die Mails unmarkiert und werden beim nächsten Lauf erneut verarbeitet (Speichern ist idempotent) |

TfL plant keine Autofahrten, deshalb bleibt `commute.driveMin` leer.

## london-weekly: Ablauf

Läuft sonntags um 18:00 (Zeitzone Europe/London) und macht drei Dinge:

1. **Stapel für die kommende Woche** (`batches/<ISO-Woche des Montags>`, Spec §6.2): aus allen Inseraten mit `status: new` ohne `duplicateOf`. Etwa 50 % höchste Prognose, 30 % unsicherste (Prognose nahe 3, keine Prognose oder viele Warnhinweise), 20 % bewusst untypisch (Postcode-Bezirk oder Preisklasse, die im Stapel noch fehlt). Die Reihenfolge wird gemischt, damit sie nichts verrät; dieselbe Woche ergibt denselben Stapel. Die Inserate bekommen `status: queued` und `reviewWeek`. Größe über `batchSize` in den Settings (Standard 12).
2. **Abschluss der laufenden Woche**: Kennzahlen in `batches/<woche>.metrics` (je Person MAE und Trefferquote ±1 gegen die Prognose zum Bewertungszeitpunkt, Einigkeit, Uneinigkeiten ≥ 2, Abdeckung der letzten 7 Tage: neu/Duplikate). Gesehene Inserate (bewertet oder übersprungen) werden `reviewed`, nicht gesehene wieder `new` und kommen zurück in den Topf.
3. **Phase-2-Prüfung** (Spec §3) in `config/status`: `weeksAtTarget` zählt die Wochen in Folge, in denen die Prognose bei mindestens 80 % von Philipps Bewertungen höchstens 1 daneben lag. Eine Woche zählt nur mit mindestens 5 Bewertungen. Ab 4 Wochen steht `readyForHunt: true`. Die Phase umschalten (`config/criteria.phase = "hunt"`) bleibt eure Entscheidung.
4. **„Review bereit“**: Platzhalter-Node mit Woche, Mischung, Kennzahlen und Phase-Stand; der Kanal ist offener Punkt 7.
5. **Profil-Update** (Spec §6.3), sobald es mindestens 15 bewertete Inserate gibt und seit dem letzten Profil neue dazugekommen sind:
   - Gemini bekommt alle Bewertungen mit Gründen und Notizen und schlägt Regeln (höchstens 10), 6–10 Few-Shot-Beispiele und mögliche harte Filter vor.
   - **Backtest:** Die bis zu 40 zuletzt bewerteten Inserate, die keines der beiden Profile als Beispiel nutzt, werden einmal mit dem alten und einmal mit dem neuen Profil bewertet (je ein Gemini-Aufruf). Verglichen wird mit dem Mittel aus beiden Bewertungen.
   - Nur bei kleinerem MAE wird das neue Profil als `profiles/<version+1>` gespeichert. Sonst bleibt das alte, der Grund steht in der Ausführung.
   - Harte Filter werden nie übernommen: Bestätigte bleiben in `hardFilters`, Geminis Vorschläge landen in `suggestedHardFilters`.

Ein zweiter Lauf in derselben Woche baut keinen zweiten Stapel und rechnet kein neues Profil, solange keine neuen Bewertungen dazugekommen sind.

## Einrichtung in n8n

1. `london-ingest.json` und `london-weekly.json` importieren (Workflows → Import from File).
2. In beiden Workflows im Node **Settings** `projectId` eintragen. `geminiModel` steht auf `gemini-3.8-flash`.
3. Credentials anlegen und in den Nodes auswählen:

   | Name im Workflow | Typ | Inhalt |
   |---|---|---|
   | AgentMail | Header Auth | Name `Authorization`, Wert `Bearer <AgentMail-API-Key>` |
   | Firestore Service Account | Google Service Account | Service-Account mit Rolle *Cloud Datastore User*; „Set up for use in HTTP Request node“ an, Scope `https://www.googleapis.com/auth/datastore` |
   | Gemini API key | Header Auth | Name `x-goog-api-key`, Wert = API-Key aus Google AI Studio (aistudio.google.com → Get API key) |
   | TfL app_key | Query Auth | Name `app_key`, Wert = Key von api-portal.tfl.gov.uk |

4. In Firestore `config/criteria` anlegen, mindestens `{ "phase": "calibrate" }`. Sobald die offenen Punkte 1–3 entschieden sind: `maxPriceMonthly`, `minBeds`, `maxCommuteMin`. Ab Phase 2 `phase` auf `"hunt"` setzen.
5. Im Node **Settings** steht `agentmailInbox: "london@agentmail.to"`. Das Postfach ist nur für die Suche da: Jede Mail, die nicht von Rightmove, Zoopla oder OpenRent kommt, gilt als Agentur-Mail und geht an Gemini. Bestätigungsmails der Portale („Alert bestätigen“) einmal in der AgentMail-Konsole öffnen und den Link klicken; der Workflow findet darin keine Inserate und markiert sie nur. AgentMail filtert Spam: Die Liste schließt Spam aus, also in den ersten Tagen in der Konsole prüfen, ob Portal-Mails dort landen.
6. Beide Workflows aktivieren.

## Gemini

- Gemini API (Google AI Studio), Endpunkt `models/{geminiModel}:generateContent`. Das Modell steht im Node **Settings** (Standard `gemini-3.8-flash`) und lässt sich dort ohne Neubau wechseln, z. B. auf `gemini-4-argon`.
- Structured Output über `responseMimeType: "application/json"` und `responseJsonSchema`, also immer gültiges JSON. Gedanken-Teile der Antwort (`thought: true`) werden beim Lesen übersprungen.
- Extraktion mit `thinkingLevel: low`, Prognose und Backtest mit `medium`, Profil-Ableitung mit `high`. `maxOutputTokens` zählt die Denk-Tokens mit; deshalb sind die Grenzen großzügig (8 K bis 32 K).
- Bricht Gemini ab (`MAX_TOKENS`, `SAFETY`, blockierte Anfrage), meldet der lesende Code-Node den Grund. Bei der Extraktion bleiben dann die vollständig geparsten Inserate, bei der Prognose wird das Inserat mit `prediction: null` und `predictionError` gespeichert.
- Kosten: Mit Flash und 50–150 Inseraten pro Woche liegt der Verbrauch im Rahmen des kostenlosen Kontingents oder sehr niedrig. **Datennutzung:** Im kostenlosen Tarif darf Google Ein- und Ausgaben zur Verbesserung seiner Produkte verwenden; das betrifft Inseratsdaten, Bewertungen und Notizen. Mit aktivierter Abrechnung im AI-Studio-Projekt gilt das nicht.

## Tests

- `npm test`: Unit-Tests der Logik in `src/` mit **synthetischen** Alert-Mails (`test/fixtures/`). Echte Mails gibt es noch nicht (Spec §9 Schritt 2). Sobald welche ankommen, anonymisierte Kopien als Fixtures ablegen und `src/parse.js` daran nachschärfen.
- `test/e2e/`: führt die gebauten Workflows in einem echten n8n aus, mit einem Mock-Server für Firestore, Gemini, TfL und postcodes.io.
  - `ingest.mjs` prüft Parser-Pfad, Gemini-Fallback, Duplikat, bekanntes Inserat, Prognose mit Profil und Few-Shot und die Benachrichtigung in der Jagd-Phase.
  - `weekly.mjs` prüft Stapel (Größe, Mischung, ohne Duplikat, untypisches Inserat dabei), Abschluss der Vorwoche mit Kennzahlen, Phase-2-Prüfung, Benachrichtigung, Profil-Update mit Backtest und einen zweiten Lauf ohne Wirkung.

  Braucht ein separat installiertes n8n (Node 24):

  ```bash
  npm i --prefix /tmp/n8n n8n
  N8N_BIN=/tmp/n8n/node_modules/n8n/bin/n8n node test/e2e/ingest.mjs
  N8N_BIN=/tmp/n8n/node_modules/n8n/bin/n8n node test/e2e/weekly.mjs
  ```

# London Wohn-Review

Wöchentliche Bewertung von Mietinseraten rund um die Deutsche Schule London, damit ein Modell lernt, was für die Familie passt. Die ganze Spezifikation steht in [`docs/spec.md`](docs/spec.md).

Dieses Repo enthält den Teil, der als Code gepflegt wird (Spec §4, Variante B):

| Ordner | Inhalt |
|---|---|
| `web/` | Web-App für Philipp und Manuela (Review und Wochenabschluss), aufgebaut aus Prototyp v2; Deploy auf Cloud Run |
| `firestore/` | Firestore-Sicherheitsregeln mit Tests gegen den Emulator |
| `docs/` | Spezifikation |

Die Datenbeschaffung (Alert-Mails → Parser → TfL → Prognose → Firestore) läuft in n8n und liegt nicht in diesem Repo.

## Web-App lokal starten

```bash
cd web
npm install
npm run dev        # http://localhost:5173 – Demo-Modus mit den 8 Inseraten aus dem Prototyp
npm test           # Kennzahlen und Formatierung
npm run typecheck
```

Ohne Firebase-Konfiguration läuft die App im **Demo-Modus**: Beispielinserate, Bewertungen nur im Browser (localStorage), Umschalter Philipp/Manuela oben rechts. Mit `?demo` in der URL lässt sich der Demo-Modus auch in Produktion erzwingen.

### Was die App kann

- **Review:** ein Inserat pro Bildschirm, Bewertung 1–5, Prognose und Begründung erst nach der Bewertung, Gründe-Tags und Notiz, Überspringen (speichert `score: null`). Wer zwischendurch abbricht, macht beim nächsten offenen Inserat weiter.
- **Wochenabschluss:** bewertet, Trefferquote ±1, MAE, gelernte Regeln (aus dem neuesten `profiles`-Dokument, sonst Hinweise aus den Tags der Woche), Tabelle P / M / KI, Uneinigkeit ≥ 2 orange markiert, Einigkeit in Prozent.
- Jede Person lädt bis zum eigenen Wochenabschluss nur ihre eigenen Bewertungen (Spec §6.1, Punkt 7).

## Firestore

Collections und Felder wie in Spec §5.4. Die App schreibt nur:

- `ratings/{listingId}_{rater}` – die eigene Bewertung
- `batches/{week}.completed.<rater>` – Zeitstempel beim eigenen Wochenabschluss

Alles andere (`listings`, `batches`, `profiles`, `config`) schreibt n8n mit einem Service-Account. Damit die App die Daten lesen kann, muss n8n beachten:

- `batches/{week}`: Dokument-ID = ISO-Woche wie `2026-W45`, Felder `week` (gleicher Wert), `listingIds`, `createdAt`, `completed: {}`. Die App nimmt den Stapel mit der höchsten `week`.
- `listings/{listingId}`: `prediction.score` muss gesetzt sein, sonst zeigt die Karte „noch keine Prognose“. `commute` mit `walkMin`, `transitMin`, `transitSummary` (z. B. „Bus 65“), `driveMin`. Optional `highlight` als Freitext für „Besonderheit“ (steht nicht im Datenmodell der Spec, wird aber in Prototyp und Karte gebraucht).
- Bekannte `flags` mit deutschem Text: `term_too_short`, `over_budget`, `few_beds`, `periodic_risk`. Andere Flags erscheinen unverändert.

**Zugang:** Die Allowlist liegt in `config/access` und wird von Hand in der Firebase-Konsole gepflegt:

```json
{ "raters": { "philipp@…": "philipp", "manuela@…": "manuela" } }
```

E-Mail-Adressen kleingeschrieben. Die Regeln in `firestore/firestore.rules` lassen nur diese Konten mit bestätigter E-Mail lesen und jede Person nur ihre eigenen Bewertungen schreiben.

```bash
cd firestore
npm install
npm test           # startet den Firestore-Emulator (braucht Java) und prüft die Regeln
npm run deploy     # Regeln und Indizes ins Projekt (firebase login / --project nötig)
```

## Einrichtung GCP / Firebase (einmalig)

Offener Punkt 6 der Spec (neues oder bestehendes Projekt) ist noch nicht entschieden. Die Schritte sind in beiden Fällen gleich:

1. Firebase zum GCP-Projekt hinzufügen, Firestore (Native, Region `europe-west2`) anlegen.
2. Authentication → Anbieter **Google** aktivieren.
3. Projekteinstellungen → Web-App registrieren und die Konfiguration (`apiKey`, `authDomain`, `projectId`, `appId`, …) notieren.
4. `config/access` wie oben anlegen.
5. Regeln deployen (`cd firestore && npx firebase deploy --only firestore --project <id>`).
6. Web-App auf Cloud Run deployen:

   ```bash
   # env.yaml (nicht einchecken):
   # FIREBASE_CONFIG: '{"apiKey":"…","authDomain":"<id>.firebaseapp.com","projectId":"<id>","appId":"…"}'
   gcloud run deploy london-wohn-review --source web --region europe-west2 \
     --allow-unauthenticated --env-vars-file env.yaml
   ```

   `--allow-unauthenticated` ist gewollt: Die Seite selbst ist öffentlich, die Daten schützt Firebase Auth mit den Firestore-Regeln.
7. Die Cloud-Run-Domain unter Authentication → Einstellungen → **Autorisierte Domains** eintragen.

Die Firebase-Web-Konfiguration ist kein Geheimnis; sie wird zur Laufzeit von `web/server/server.mjs` als `/config.js` ausgeliefert, damit ein Image für jedes Projekt passt.

## Noch nicht gebaut

- n8n-Workflows `london-ingest` und `london-weekly` (Spec §5.3)
- Benachrichtigungen (offener Punkt 7)
- Echte Fotos statt Farbkachel (offener Punkt 9)
- Spätere Ansichten: Karte, Favoriten, Vergleich, Prognosegüte im Zeitverlauf (Spec §5.5)

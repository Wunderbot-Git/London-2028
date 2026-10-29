# London Wohn-Review – Spezifikation

**Stand:** 26. Oktober 2026 · **Status:** Konzept steht, UI-Prototyp v2 abgenommen („erstmal ok“), Technik noch nicht gebaut

---

## 1. Kontext und Ziel

Die Familie plant einen London-Aufenthalt von **6 Monaten ab Januar 2028**. Die Kinder besuchen in dieser Zeit die **Deutsche Schule London (DSL)**, Douglas House, Petersham Road, Richmond TW10 7AH.

Gesucht wird ein möbliertes Haus oder eine Wohnung für die Familie (2 Erwachsene, 2 Kinder) in vertretbarer Entfernung zur DSL.

**Das System soll zwei Dinge leisten:**

1. **Kalibrieren (jetzt bis Sommer 2027):** Philipp und Manuela bewerten wöchentlich echte Inserate mit 1–5. Daraus lernt das System, was für die Familie interessant ist, und beide entwickeln ein Gefühl für einen Markt, den sie noch nicht kennen.
2. **Jagen (ab ca. September 2027):** Das System prüft neue Inserate täglich und meldet nur noch die, die es mit hoher Sicherheit als interessant einschätzt.

**Nicht-Ziele**
- Kein Scraping von Inseratsseiten. Die Portale blockieren es und verbieten es in ihren Nutzungsbedingungen. Datenquelle sind ausschließlich Alert-Mails.
  - **Ausnahme (29.10.2026):** Für die 12 Inserate des aktuellen Wochenstapels öffnet Claude die Inseratsseiten in Philipps eigenem Chrome und übernimmt Details und Fotos (`tools/enrich/`). Kein serverseitiger Abruf, keine Massenabfragen.
- Keine automatische Kontaktaufnahme mit Vermietern. Anfragen werden höchstens als Entwurf vorbereitet.
- Kein allgemeiner Marktbericht.

---

## 2. Marktkontext (Annahmen fürs Design)

- **Renters' Rights Act 2025 (seit 1. Mai 2026 in Kraft):** Befristete Mietverträge (ASTs mit 6 oder 12 Monaten) gibt es nicht mehr; alle regulären Mietverhältnisse sind unbefristet. Mieter können jederzeit mit 2 Monaten Frist kündigen.
- **Folge für die Suche:** Ein klassischer 6-Monats-Mietvertrag existiert nicht mehr. Relevante Kategorien sind:
  - **Short Let / Licence to occupy:** möbliert, oft mit Nebenkosten, teurer
  - **Flexible Lets** über private Vermieter, z. B. auf OpenRent
  - **Corporate- oder Executive-Lets** mit maximaler Laufzeit
  - **Reguläre unbefristete Miete** (günstiger; rechtlich mit 2 Monaten kündbar, Vermieter bevorzugen aber Langzeitmieter)
  - **Home Exchange** (nicht automatisierbar)
- **Preisrahmen (Stichprobe Oktober 2026):** Ein Haus im Bezirk Richmond kostet im Schnitt etwa £2.700 im Monat bei regulärer Miete. Ein möbliertes Haus mit 3 Schlafzimmern als Short Let nahe der DSL liegt bei etwa £5.500–7.000 im Monat.
- **Vorlauf:** Reguläre Inserate erscheinen meist 1–3 Monate vor Einzug. Der eigentliche Suchzeitraum ist also etwa Oktober bis Dezember 2027.

---

## 3. Phasen

| Phase | Zeitraum | Takt | Ergebnis |
|---|---|---|---|
| 0 – Setup | Nov 2026 | – | Agent-Mailkonto, Suchalerts, Firestore, n8n-Workflow, Web-App |
| 1 – Kalibrierung | Nov 2026 – Aug 2027 | wöchentliches Review (10–15 Inserate) | Bewertungen, Präferenzprofil, Prognosegüte |
| 2 – Jagd | Sep – Dez 2027 | täglich | Sofortmeldung bei Prognose ≥ 4, Anfrage-Entwurf |
| 3 – Einzug | Jan 2028 | – | System stilllegen, Agent-Adresse deaktivieren |

**Übergangskriterium Phase 1 → 2:** Die Prognose liegt in mindestens 80 % der Fälle innerhalb von ±1 zur Bewertung von Philipp, über mindestens 4 aufeinanderfolgende Wochen.

---

## 4. Architektur

```
Portale (Rightmove, Zoopla, OpenRent, Agenturen)
        │  Suchalerts per E-Mail
        ▼
Agent-Postfach (AgentMail, london@agentmail.to)
        │
        ▼
n8n (self-hosted) ──► TfL Journey Planner API (Schulweg)
        │          ──► Gemini API (Extraktion-Fallback, Prognose, Profil)
        ▼
Firestore (GCP)  ◄──►  Web-App (Cloud Run): Review-Oberfläche für Philipp und Manuela
```

**Entscheidung:** Variante B, also n8n für Datenbeschaffung und Logik plus eine eigene Web-App für die Oberfläche. Begründung: Die Oberfläche wird über 15 Monate oft angepasst, sie braucht zwei Personen mit Login und soll später Karte und Vergleich bekommen. Das ist in einem normalen Repo mit Claude Code besser aufgehoben als als HTML in einem n8n-Node.

**Verworfen:**
- Telegram als Bewertungskanal (vom Nutzer nicht gewünscht)
- Mail mit Bewertungslinks (umständlich)
- Oberfläche direkt aus n8n ausgeliefert (Variante A, schwer zu pflegen)
- Geplante Aufgabe in Claude statt n8n (unabhängiger Betrieb gewünscht)

---

## 5. Komponenten

### 5.1 Agent-Postfach
- AgentMail-Postfach `london@agentmail.to`, ausschließlich für die Suche (statt eines Gmail-Kontos; n8n fragt es per API ab)
- Empfängt alle Suchalerts und Agentur-Newsletter
- Später optional Absender für Anfragen (Entwürfe, kein automatischer Versand)

### 5.2 Suchalerts (manuell einrichten)

| Portal | Filter (Startwerte, offen) |
|---|---|
| Rightmove | Radius um TW10 7AH, To Rent, Furnished, 3+ Beds, Short Let / Let type |
| Zoopla | Gebiete TW10, TW9, KT2, SW14; Furnished; 3+ Beds |
| OpenRent | Richmond / Ham / Kingston, 3+ Beds |
| Agenturen | Short-Let-Abteilungen in Richmond und Kingston (Newsletter) |

Gebiete nach Priorität: **Petersham, Ham** (zu Fuß) → **Richmond** (Bus 65/371) → **North Kingston, East Sheen** → Wimbledon/Southfields (nur zum Vergleich).

### 5.3 n8n-Workflow „london-ingest“

| # | Node | Aufgabe |
|---|---|---|
| 1 | Abfrage des AgentMail-Postfachs (alle 3 Stunden beim Kalibrieren, alle 15 Min. in der Jagdphase) | neue, noch nicht verarbeitete Mails |
| 2 | Router nach Absender | ein Zweig pro Portal |
| 3 | Parser (Code-Node je Portal) | Inserate aus dem Mail-HTML ziehen: URL, Quelle, Quell-ID, Titel/Adresse, Postcode, Preis, Zimmer, Bild-URL, Schlagworte |
| 4 | LLM-Fallback | wenn der Parser scheitert oder Felder fehlen: Extraktion per Gemini in festes JSON-Schema |
| 5 | Normalisieren | Preis auf pcm, Mietform auf Enum, Postcode-Bereich |
| 6 | Deduplizieren | Abgleich mit Firestore (Quell-ID, sonst Fingerprint) |
| 7 | Geocoding + Schulweg | TfL Journey Planner zur DSL: zu Fuß, ÖPNV; optional Auto |
| 8 | Prognose | Gemini bewertet mit aktuellem Präferenzprofil + Few-Shot-Beispielen → Score 1–5 + Begründung |
| 9 | Speichern | Firestore `listings` |
| 10 | Benachrichtigung (nur Phase 2) | bei Prognose ≥ 4 sofort; Kanal noch offen |

**Zweiter Workflow „london-weekly“** (sonntags):
1. Review-Stapel der Woche zusammenstellen (siehe 6.2)
2. Benachrichtigung „Review bereit“ an beide
3. Nach Abschluss: Präferenzprofil neu ableiten (siehe 6.3)

### 5.4 Firestore-Datenmodell

**`listings/{listingId}`**

| Feld | Typ | Bemerkung |
|---|---|---|
| source | string | `rightmove` \| `zoopla` \| `openrent` \| `agency:<name>` |
| sourceId | string | ID aus dem Portal |
| url | string | |
| fingerprint | string | normierte Adresse + Postcode + Zimmer, für Duplikate |
| duplicateOf | string? | listingId des Originals |
| address, postcode, area | string | `postcode` z. B. „TW10 7“ |
| lat, lng | number? | |
| priceMonthly | number | GBP pcm |
| billsIncluded | bool? | |
| letType | enum | `short_let` \| `flexible` \| `periodic` \| `corporate` \| `licence` \| `unknown` |
| minTermMonths, maxTermMonths | number? | |
| availableFrom | date? | |
| beds, baths | number | |
| furnished | enum | `furnished` \| `part` \| `unfurnished` \| `either` \| `unknown` |
| propertyType | enum | `flat` \| `maisonette` \| `detached` \| `semi_detached` \| `terraced` \| `house` \| `unknown` (aus der Alert-Mail) |
| agent | string? | Makler laut Alert-Mail („Marketed by …“) |
| priceReduced | bool? | Alert meldet eine Preissenkung |
| sizeSqm, deposit, description, keyFeatures, floorplans | – | von der Inseratsseite (`tools/enrich`), nur für Stapel-Inserate |
| letAgreed | bool? | laut Inseratsseite schon vermietet |
| detailsFetchedAt | timestamp? | wann die Details geholt wurden |
| garden, parking | bool? | |
| epc | string? | |
| photos | string[] | Bild-URLs aus der Alert-Mail |
| commute | map | `{ walkMin, transitMin, transitSummary, driveMin, computedAt }` |
| flags | string[] | z. B. `term_too_short`, `over_budget`, `few_beds`, `periodic_risk` |
| prediction | map | `{ score, rationale, profileVersion, model, createdAt }` |
| status | enum | `new` \| `queued` \| `reviewed` \| `archived` |
| reviewWeek | string? | z. B. `2026-W45` |
| firstSeenAt, lastSeenAt | timestamp | |
| rawMessageId | string | AgentMail-Message-ID zur Nachverfolgung |

**`ratings/{listingId}_{rater}`**

| Feld | Typ | Bemerkung |
|---|---|---|
| listingId | string | |
| rater | enum | `philipp` \| `manuela` |
| score | number? | 1–5; `null` = übersprungen |
| tags | string[] | aus fester Liste (siehe 6.1) |
| note | string | Freitext |
| predictionAtRating | number | Prognose zum Zeitpunkt der Bewertung (für Messung) |
| createdAt | timestamp | |

**`profiles/{version}`**

| Feld | Typ | Bemerkung |
|---|---|---|
| version | number | fortlaufend |
| createdAt | timestamp | |
| basedOnRatings | number | Anzahl Bewertungen |
| hardFilters | map | `{ maxPriceMonthly, minBeds, maxCommuteMin }` – nur was die Familie bestätigt hat |
| rules | string[] | abgeleitete Regeln in Klartext, z. B. „Garten wichtiger als 4. Schlafzimmer“ |
| fewShot | string[] | listingIds besonders aussagekräftiger Bewertungen |
| metrics | map | `{ mae, hitRateWithin1, n }` |
| confirmedBy | string[] | wer die Regeln abgenickt hat |

**`batches/{week}`**: `{ week, listingIds[], createdAt, completed: { philipp?: ts, manuela?: ts } }`

**`config/criteria`**: Startwerte für Budget, Mindestzimmer, maximalen Schulweg und Gebietsliste.

### 5.5 Web-App
- **Stack:** Repo auf GitHub, Deploy auf Cloud Run; Firebase Auth mit Google-Login und Allowlist für zwei Konten
- **Ansichten:**
  1. **Review:** ein Inserat pro Bildschirm (siehe 6.1)
  2. **Wochenabschluss:** Kennzahlen, gelernte Regeln, Tabelle Philipp / Manuela / Prognose
  3. **Später:** Kartenansicht, Favoriten, Vergleich, Prognosegüte im Zeitverlauf
- **Mobile first,** Hell- und Dunkelmodus
- **Referenz:** Prototyp v2 (Claude-Artifact „London Wohn-Review“)

---

## 6. Funktionale Definition

### 6.1 Review-Ablauf (je Inserat)
1. Karte zeigt: Foto (später echt, aktuell Farbkachel mit Postcode), Straße und Gebiet, **Preis pro Monat**, Zimmer · Bäder · Garten, Schulweg und Mietform, Warnhinweis (falls ein Flag gesetzt ist)
2. „Details“ klappt auf: Einrichtung, alternativer Schulweg, Verfügbarkeit, Besonderheit, Energieklasse, Preis pro Woche, Link zum Inserat
3. Bewertung über 5 runde Tasten; das Wort darunter wechselt: Nein / Eher nicht / Vielleicht / Interessant / Unbedingt
4. **Erst nach der Bewertung** erscheinen: Prognose, Abweichung (Treffer / knapp daneben / n daneben) und Begründung
5. Optional: Gründe-Tags und Notiz
   - Tags: Zu teuer · Zu weit · Zu klein · Kein Garten · Laufzeit · Lage · Das Haus · Preis–Leistung
6. „Weiter“ speichert und zeigt das nächste Inserat; vor der Bewertung ist „Überspringen“ möglich
7. Philipp und Manuela bewerten unabhängig voneinander und sehen die Bewertung des anderen erst im Wochenabschluss

### 6.2 Auswahl des Wochenstapels
- 10–15 Inserate, nur noch nicht bewertete
- **Nicht nur Top-Prognosen:** Die Mischung soll dem Lernen dienen:
  - ca. 50 % höchste Prognose
  - ca. 30 % unsicherste Prognose (Score um 3 oder widersprüchliche Merkmale)
  - ca. 20 % bewusst untypisch (anderes Gebiet, andere Preisklasse)
- Duplikate werden nur einmal gezeigt

### 6.3 Lernschleife
- **Prognose:** Gemini erhält Inseratsdaten, aktuelles Profil (Regeln und harte Filter) und 6–10 Few-Shot-Beispiele mit Bewertung und Begründung. Ausgabe: `{ score: 1–5, rationale: string }`
- **Profil-Update (wöchentlich, ab 15 Bewertungen):** Gemini leitet aus allen Bewertungen, Tags und Notizen Regeln ab. Ein neues Profil wird nur übernommen, wenn es auf den bisherigen Bewertungen besser trifft als das alte (Backtest). Harte Filter werden nie automatisch gesetzt, nur vorgeschlagen.
- **Uneinigkeit:** Liegen Philipp und Manuela 2 oder mehr Punkte auseinander, markiert der Wochenabschluss das Inserat. In die Prognose geht der Mittelwert ein.

### 6.4 Kennzahlen
- **MAE:** mittlere absolute Abweichung Prognose vs. Bewertung
- **Trefferquote ±1:** Anteil Bewertungen mit Abweichung ≤ 1
- **Abdeckung:** Inserate pro Woche, davon neu und davon Duplikate
- **Einigkeit:** Anteil Inserate mit Abweichung Philipp/Manuela ≤ 1

---

## 7. Datenschutz und Betrieb
- Firestore und App nur für die zwei freigegebenen Konten
- Keine Daten von Vermietern über das hinaus, was in den Alert-Mails steht
- API-Keys (Gemini, TfL) nur als n8n-Credentials bzw. GCP Secret Manager
- Kosten: Cloud Run und Firestore im Gratisrahmen erwartet; Gemini-API-Kosten gering (ca. 50–150 Inserate pro Woche)
- Nach Einzug: Alerts abbestellen, Agent-Konto stilllegen, Daten exportieren und löschen

---

## 8. Offene Punkte

| # | Frage | Wer |
|---|---|---|
| 1 | Budget pro Monat (Start-Leitplanke) | Philipp & Manuela |
| 2 | Mindestzahl Schlafzimmer | Philipp & Manuela |
| 3 | Maximaler Schulweg, mit oder ohne Auto in London | Philipp & Manuela |
| 4 | ~~Agent-Mailkonto angelegt? Adresse?~~ Erledigt: `london@agentmail.to` (AgentMail) | Philipp |
| 5 | n8n von außen per HTTPS erreichbar? MCP-Zugang aktivierbar? | Philipp |
| 6 | GCP-Projekt: neu oder bestehendes? | Philipp |
| 7 | Benachrichtigungskanal für Phase 2 und „Review bereit“ (Push der Web-App, Mail, WhatsApp) | offen |
| 8 | Bewertet Manuela von Anfang an mit? | Philipp & Manuela |
| 9 | Hotlinking der Inseratsfotos aus Alert-Mails zulässig, oder nur Link? | prüfen |

---

## 9. Nächste Schritte
1. Offene Punkte 1–6 klären
2. Agent-Mailkonto anlegen und Suchalerts einrichten, damit echte Testmails entstehen
3. Firestore-Projekt und Datenmodell anlegen
4. n8n-Workflow „london-ingest“ bauen; Parser an echten Mails je Portal testen
5. Web-App aus Prototyp v2 aufbauen und an Firestore anbinden
6. Erstes echtes Wochen-Review (Ziel: Mitte November 2026)

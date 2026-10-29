# Details aus den Inseraten (Wochenstapel)

Die Alert-Mails enthalten nur Preis, Zimmer, Adresse und ein Vorschaubild. Für die Inserate im
**aktuellen Wochenstapel** (12 pro Woche) holt dieser Schritt die übrigen Angaben von der
Inseratsseite: alle Fotos, Grundriss, Bäder, Größe, Möblierung, Verfügbarkeit, Mietform,
Kaution, Makler, Merkmale, Beschreibung und ob das Inserat schon vermietet ist.

**Wie:** Claude öffnet jede Seite in Philipps eigenem Chrome (Claude in Chrome) und liest mit
`extract.js` nur, was die Seite ohnehin enthält. Kein Abruf durch n8n oder einen Server, keine
Massenabfragen: eine Seite nach der anderen, nur die Inserate des Stapels. Das ist eine bewusste
Ausnahme von Spec §1 („kein Scraping“), beschlossen am 29.10.2026.

## Ablauf

1. Offene Inserate des neuesten Stapels (auf Philipps Mac, mit dem gcloud-Konto des Projekts):

   ```bash
   python3 tools/enrich/firestore_enrich.py todo        # id<TAB>url, nur ohne detailsFetchedAt
   ```

2. Für jedes Inserat in Chrome: Seite öffnen, kurz warten, dann im Seitenkontext ausführen:

   ```js
   /* Inhalt von tools/enrich/extract.js */ ; JSON.stringify(extractListing(window))
   ```

3. Ergebnisse sammeln als `{"items":[{"id":"…","data":{…}}, …]}` und schreiben:

   ```bash
   python3 tools/enrich/firestore_enrich.py write ergebnisse.json
   ```

   Gesetzt werden nur die Detailfelder (`updateMask`), dazu `detailsFetchedAt`, neu berechnete
   Flags (`periodic_risk`, `let_agreed`) und `predictionError = "Neu bewerten: …"`, damit
   `london-ingest` die Prognose beim nächsten Lauf mit den Details neu rechnet.

Die App zeigt danach alle Fotos als Leiste unter dem großen Foto, Größe und Kaution, Grundriss,
Merkmale und Beschreibung unter „Details“ und den Hinweis „Laut Portal schon vermietet“.

## Tests

```bash
node --test tools/enrich/extract.test.mjs              # Ausleser gegen nachgebaute Seiten
python3 -m unittest tools/enrich/test_firestore_enrich.py
```

Die Seitenstrukturen (Rightmove `__PAGE_MODEL`, OnTheMarket `__NEXT_DATA__`, Zoopla
`self.__next_f` + JSON-LD) können sich ändern. Liefert `extract.js` plötzlich leere Felder,
eine Seite in Chrome öffnen, die Struktur prüfen und `extract.js` samt Test anpassen.

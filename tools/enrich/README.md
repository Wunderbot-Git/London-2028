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

2. Empfänger auf dem Mac starten (nur 127.0.0.1; Port 8765 ist dort belegt, daher 8791):

   ```bash
   python3 tools/enrich/receiver.py /tmp/lwr/results-W45.json --port 8791
   ```

3. Für jedes Inserat in Chrome: Seite öffnen, 2 s warten, dann im Seitenkontext ausführen
   (`<ID>` = Firestore-ID aus Schritt 1):

   ```js
   /* Inhalt von tools/enrich/extract.js */
   const json = JSON.stringify(extractListing(window)); const bytes = new TextEncoder().encode(json);
   let bin = ''; bytes.forEach((c) => (bin += String.fromCharCode(c)));
   const d = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
   setTimeout(() => { location.href = 'http://127.0.0.1:8791/save?id=<ID>&d=' + d; }, 50);
   ```

   Der Tab landet auf `/ok?id=<ID>` mit „LWR-OK … photos=… baths=…“. So kommen die Daten ohne
   Kopieren auf den Mac (die Zwischenablage ist für Claude in Chrome gesperrt).

4. Schreiben und Empfänger beenden:

   ```bash
   python3 tools/enrich/firestore_enrich.py write /tmp/lwr/results-W45.json
   curl -s http://127.0.0.1:8791/stop
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

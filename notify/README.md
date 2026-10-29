# notify – Web-Push bei neuem Wochenstapel

Cloud Function (2. Generation, Node 22) im GCP-Projekt `london-513016`, Region `europe-west1`,
Firestore-Trigger in `eur3`. Ein Einstiegspunkt `notify`, zwei Trigger:

| Funktion | Ereignis | Wirkung |
|---|---|---|
| `lwr-notify-batch` | `batches/{week}` angelegt (london-weekly, sonntags 18:00 London) | „Neue Inserate zum Bewerten“ an alle angemeldeten Geräte; `notifiedAt` am Stapel verhindert Doppelversand |
| `lwr-notify-welcome` | `pushSubscriptions/{id}` angelegt (Knopf „Mitteilungen“ in der App) | Bestätigung an genau dieses Gerät |

Abgelaufene Anmeldungen (Antwort 404/410 des Push-Dienstes) werden gelöscht.

## Schlüssel

VAPID-Schlüsselpaar: der öffentliche Schlüssel steht als `VAPID_PUBLIC_KEY` in der Funktion und im
Cloud-Run-Dienst `london-wohn-review` (die App liest ihn aus `/config.js`). Der private Schlüssel liegt
nur im Secret Manager (`lwr-vapid-private`) und wird der Funktion als `VAPID_PRIVATE_KEY` übergeben.

## Ausrollen

```bash
for f in batch:batches/{week} welcome:pushSubscriptions/{id}; do
  gcloud functions deploy lwr-notify-${f%%:*} --gen2 --runtime=nodejs22 --region=europe-west1 \
    --source=notify --entry-point=notify \
    --trigger-location=eur3 \
    --trigger-event-filters=type=google.cloud.firestore.document.v1.created \
    --trigger-event-filters=database='(default)' \
    --trigger-event-filters-path-pattern=document="${f#*:}" \
    --set-env-vars=VAPID_PUBLIC_KEY=<öffentlicher Schlüssel>,VAPID_SUBJECT=https://london-wohn-review-999562988455.europe-west2.run.app \
    --set-secrets=VAPID_PRIVATE_KEY=lwr-vapid-private:latest \
    --project=london-513016
done
```

## Tests

```bash
cd notify && npm test
```

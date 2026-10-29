#!/usr/bin/env python3
"""Details from the listing pages → listings/{id} in Firestore (see tools/enrich/README.md).

  python3 firestore_enrich.py todo  [--project P] [--account A] [--all]
      Prints id<TAB>url of the newest batch's listings that have no details yet (--all: every one).
  python3 firestore_enrich.py write FILE [--project P] [--account A]
      FILE = JSON {"items": [{"id": "...", "data": <extractListing(window) result>}, ...]}.
      Sets only the detail fields (updateMask), recomputes the flags that depend on them and marks
      the listing for a new prediction (london-ingest's rescore branch picks it up).

Auth: `gcloud auth print-access-token` for the given account (project owner or Datastore user).
Standard library only, so it runs on any Mac with Python 3 and gcloud.
"""
import json
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone

PROJECT = "london-513016"
ACCOUNT = "wunderbot80@gmail.com"
DETAIL_FIELDS = [
    "baths", "sizeSqm", "furnished", "availableFrom", "letType", "minTermMonths", "deposit", "agent",
    "propertyType", "description", "keyFeatures", "photos", "floorplans", "epc", "letAgreed",
]
# Flags that depend on detail fields; everything else (over_budget, too_far, …) stays as it is.
DETAIL_FLAGS = {"periodic_risk", "term_too_short", "let_agreed"}
RESCORE = "Neu bewerten: Details aus dem Inserat nachgeladen"


def arg(name, default):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def token(account):
    return subprocess.check_output(["gcloud", "auth", "print-access-token", f"--account={account}"], text=True).strip()


def call(method, url, tok, project, body=None):
    req = urllib.request.Request(
        url, method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {tok}", "x-goog-user-project": project, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as r:
        return json.load(r)


def to_value(v):
    if v is None:
        return {"nullValue": None}
    if isinstance(v, bool):
        return {"booleanValue": v}
    if isinstance(v, int):
        return {"integerValue": str(v)}
    if isinstance(v, float):
        return {"doubleValue": v}
    if isinstance(v, str):
        return {"stringValue": v}
    if isinstance(v, list):
        return {"arrayValue": {"values": [to_value(x) for x in v]} if v else {}}
    if isinstance(v, dict):
        return {"mapValue": {"fields": {k: to_value(x) for k, x in v.items()}}}
    raise TypeError(type(v))


def from_value(v):
    if not v or "nullValue" in v:
        return None
    for k in ("booleanValue", "doubleValue", "stringValue", "timestampValue"):
        if k in v:
            return v[k]
    if "integerValue" in v:
        return int(v["integerValue"])
    if "arrayValue" in v:
        return [from_value(x) for x in v["arrayValue"].get("values", [])]
    if "mapValue" in v:
        return {k: from_value(x) for k, x in v["mapValue"].get("fields", {}).items()}
    return None


def detail_update(current, data, now):
    """Fields to set on listings/{id}: only values the page actually had."""
    out = {}
    for k in DETAIL_FIELDS:
        v = data.get(k)
        if v is None or v == [] or v == "":
            continue
        if k == "photos" and len(v) <= len(current.get("photos") or []):
            continue  # the alert mail had as many; keep them
        out[k] = v
    if data.get("letAgreed") is False:
        out["letAgreed"] = False
    lt = out.get("letType", current.get("letType"))
    flags = [f for f in (current.get("flags") or []) if f not in DETAIL_FLAGS]
    if lt == "periodic":
        flags.append("periodic_risk")
    if current.get("maxTermMonths") is not None and current["maxTermMonths"] < 6:
        flags.append("term_too_short")
    if out.get("letAgreed"):
        flags.append("let_agreed")
    out["flags"] = flags
    out["detailsFetchedAt"] = now
    if current.get("prediction") is not None or current.get("predictionError"):
        out["predictionError"] = RESCORE
    return out


def main():
    project, account = arg("--project", PROJECT), arg("--account", ACCOUNT)
    base = f"https://firestore.googleapis.com/v1/projects/{project}/databases/(default)/documents"
    tok = token(account)
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""

    if cmd == "todo":
        q = {"structuredQuery": {"from": [{"collectionId": "batches"}], "orderBy": [{"field": {"fieldPath": "week"}, "direction": "DESCENDING"}], "limit": 1}}
        rows = [r for r in call("POST", f"{base}:runQuery", tok, project, q) if "document" in r]
        if not rows:
            return
        ids = from_value(rows[0]["document"]["fields"]["listingIds"])
        names = [f"projects/{project}/databases/(default)/documents/listings/{i}" for i in ids]
        got = call("POST", f"{base}:batchGet", tok, project, {"documents": names, "mask": {"fieldPaths": ["url", "detailsFetchedAt"]}})
        for r in got:
            if "found" not in r:
                continue
            f = {k: from_value(v) for k, v in r["found"].get("fields", {}).items()}
            if f.get("url") and ("--all" in sys.argv or not f.get("detailsFetchedAt")):
                print(f"{r['found']['name'].rsplit('/', 1)[1]}\t{f['url']}")
        return

    if cmd == "write":
        items = json.load(open(sys.argv[2]))["items"]
        now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        for it in items:
            lid, data = it["id"], it["data"]
            if data.get("error"):
                print(f"{lid}: skipped ({data['error']})")
                continue
            doc = call("GET", f"{base}/listings/{lid}", tok, project)
            current = {k: from_value(v) for k, v in doc.get("fields", {}).items()}
            upd = detail_update(current, data, now)
            fields = {k: ({"timestampValue": v} if k == "detailsFetchedAt" else to_value(v)) for k, v in upd.items()}
            mask = "&".join(f"updateMask.fieldPaths={k}" for k in upd)
            call("PATCH", f"{base}/listings/{lid}?{mask}", tok, project, {"fields": fields})
            print(f"{lid}: {', '.join(k for k in upd if k not in ('flags', 'detailsFetchedAt', 'predictionError'))}"
                  f"{' · VERMIETET' if upd.get('letAgreed') else ''}")
        return

    print(__doc__)
    sys.exit(2)


if __name__ == "__main__":
    main()

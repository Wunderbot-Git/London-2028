#!/usr/bin/env python3
"""Tests the pushSubscriptions rules with the Firebase Rules API (no local emulator needed).

  python3 rules_api_test.py firestore.rules [--project london-513016] [--account wunderbot80@gmail.com]

Runs projects:test with mocked config/access; nothing is deployed or written.
"""
import json, subprocess, sys, urllib.request

def arg(n, d): return sys.argv[sys.argv.index(n) + 1] if n in sys.argv else d
P, A, SRC = arg("--project", "london-513016"), arg("--account", "wunderbot80@gmail.com"), sys.argv[1]
T = "2026-10-30T10:00:00Z"
H = "0123456789abcdef0123456789abcdef"
DOCS = "/databases/(default)/documents"
ACCESS = {"function": "get", "args": [{"exactValue": f"{DOCS}/config/access"}],
          "result": {"value": {"data": {"raters": {"philipp@example.com": "philipp", "manuela@example.com": "manuela"}}}}}

def auth(email, verified=True): return {"uid": email, "token": {"email": email, "email_verified": verified}}
def sub(rater, **extra):
    d = {"rater": rater, "endpoint": "https://fcm.googleapis.com/fcm/send/abc", "keys": {"p256dh": "BPk", "auth": "xyz"},
         "userAgent": "test", "createdAt": T}
    d.update(extra); return d
def case(name, expect, email, method, sid, data=None, existing=None):
    req = {"auth": auth(email), "path": f"{DOCS}/pushSubscriptions/{sid}", "method": method, "time": T}
    if data is not None: req["resource"] = {"data": data}
    c = {"expectation": expect, "request": req, "functionMocks": [ACCESS]}
    if existing is not None: c["resource"] = {"data": existing}
    return name, c

P_, M_ = "philipp@example.com", "manuela@example.com"
CASES = [
    case("own create", "ALLOW", P_, "create", f"philipp_{H}", sub("philipp")),
    case("own read", "ALLOW", P_, "get", f"philipp_{H}", existing=sub("philipp")),
    case("own delete", "ALLOW", P_, "delete", f"philipp_{H}", existing=sub("philipp")),
    case("own update", "ALLOW", P_, "update", f"philipp_{H}", sub("philipp"), existing=sub("philipp")),
    case("create under other id", "DENY", P_, "create", f"manuela_{H}", sub("manuela")),
    case("create as other rater", "DENY", P_, "create", f"philipp_{H}", sub("manuela")),
    case("read other", "DENY", P_, "get", f"manuela_{H}", existing=sub("manuela")),
    case("delete other", "DENY", P_, "delete", f"manuela_{H}", existing=sub("manuela")),
    case("overwrite other's doc", "DENY", P_, "update", f"philipp_{H}", sub("philipp"), existing=sub("manuela")),
    case("http endpoint", "DENY", P_, "create", f"philipp_{H}", sub("philipp", endpoint="http://x")),
    case("extra field", "DENY", P_, "create", f"philipp_{H}", sub("philipp", extra=1)),
    case("bad id", "DENY", P_, "create", "philipp_x", sub("philipp")),
    case("wrong time", "DENY", P_, "create", f"philipp_{H}", sub("philipp", createdAt="2020-01-01T00:00:00Z")),
    case("stranger", "DENY", "x@example.com", "create", f"philipp_{H}", sub("philipp")),
    case("manuela own", "ALLOW", M_, "create", f"manuela_{H}", sub("manuela")),
]


tok = subprocess.check_output(["gcloud", "auth", "print-access-token", f"--account={A}"], text=True).strip()
body = {"source": {"files": [{"name": "firestore.rules", "content": open(SRC).read()}]},
        "testSuite": {"testCases": [c for _, c in CASES]}}
req = urllib.request.Request(f"https://firebaserules.googleapis.com/v1/projects/{P}:test", method="POST",
                             data=json.dumps(body).encode(),
                             headers={"Authorization": f"Bearer {tok}", "x-goog-user-project": P, "Content-Type": "application/json"})
try:
    res = json.load(urllib.request.urlopen(req))
except urllib.error.HTTPError as e:
    print(e.read().decode()[:2000]); sys.exit(1)
if res.get("issues"):
    print(json.dumps(res["issues"], indent=1)[:2000])
fails = 0
for (name, _), r in zip(CASES, res.get("testResults", [])):
    ok = r.get("state") == "SUCCESS"
    fails += not ok
    print(("ok  " if ok else "FAIL"), name, "" if ok else json.dumps(r.get("debugMessages") or r)[:400])
print(f"{len(CASES) - fails}/{len(CASES)} ok"); sys.exit(1 if fails else 0)

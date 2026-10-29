// Minimal static server for Cloud Run: serves dist/ and writes /config.js from env vars,
// so the same image runs against any Firebase project. No dependencies on purpose.
//
// Env: PORT (set by Cloud Run), FIREBASE_CONFIG (JSON of the Firebase web app config; unset = demo mode),
// VAPID_PUBLIC_KEY (public Web Push key; unset = no notification button).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../dist/", import.meta.url));
const port = Number(process.env.PORT ?? 8080);

let firebase = null;
if (process.env.FIREBASE_CONFIG) {
  firebase = JSON.parse(process.env.FIREBASE_CONFIG); // fail fast on a broken value
}
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || null;
const configJs = `window.__LWR_CONFIG__ = ${JSON.stringify({ firebase, vapidPublicKey })};\n`;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

const HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);

  if (path === "/config.js") {
    res.writeHead(200, { ...HEADERS, "Content-Type": TYPES[".js"], "Cache-Control": "no-store" });
    return res.end(configJs);
  }
  if (path === "/healthz") {
    res.writeHead(200, HEADERS);
    return res.end("ok");
  }

  const file = normalize(join(root, path));
  const inside = file.startsWith(root);
  try {
    if (!inside || path.endsWith("/")) throw new Error("not a file");
    const body = await readFile(file);
    const hashed = path.startsWith("/assets/");
    res.writeHead(200, {
      ...HEADERS,
      "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
      "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
    });
    res.end(body);
  } catch {
    // Single-page app: unknown paths get index.html.
    const body = await readFile(join(root, "index.html"));
    res.writeHead(200, { ...HEADERS, "Content-Type": TYPES[".html"], "Cache-Control": "no-cache" });
    res.end(body);
  }
}).listen(port, () => console.log(`listening on :${port}${firebase ? "" : " (demo mode)"}`));

// Minimal service worker: makes the app installable, caches nothing.
// Ratings and listings always come live from Firestore; an offline copy would only show stale data.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});

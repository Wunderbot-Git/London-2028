// Web Push in the browser: what this device supports, and turning a subscription on or off.
// The subscription itself is stored in Firestore (pushSubscriptions/{rater}_{hash}) by FirebaseApp;
// the notify/ Cloud Function sends to it when a new weekly batch appears.

export type PushSupport = "ok" | "install-first" | "unsupported";
export type PushState = "on" | "off" | "denied" | "unsupported" | "install-first";

export interface PushEnv {
  userAgent: string;
  standalone: boolean;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
}

/** iPhone/iPad only offer Web Push to apps added to the home screen (iOS 16.4+). */
export function pushSupport(env: PushEnv): PushSupport {
  const ios = /iPhone|iPad|iPod/.test(env.userAgent) || (/Macintosh/.test(env.userAgent) && /Mobile/.test(env.userAgent));
  if (env.hasServiceWorker && env.hasPushManager && env.hasNotification) {
    return ios && !env.standalone ? "install-first" : "ok";
  }
  return ios && !env.standalone ? "install-first" : "unsupported";
}

export function browserPushEnv(): PushEnv {
  const nav = navigator as Navigator & { standalone?: boolean };
  return {
    userAgent: navigator.userAgent,
    standalone: nav.standalone === true || matchMedia("(display-mode: standalone)").matches,
    hasServiceWorker: "serviceWorker" in navigator,
    hasPushManager: "PushManager" in window,
    hasNotification: "Notification" in window,
  };
}

/** VAPID keys are URL-safe base64; PushManager wants the raw bytes. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Stable document id for one browser's subscription: rater + short hash of the endpoint. */
export async function subscriptionId(rater: string, endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${rater}_${hex.slice(0, 32)}`;
}

export interface SavedSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export async function currentPushState(): Promise<PushState> {
  const support = pushSupport(browserPushEnv());
  if (support !== "ok") return support;
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === "granted" ? "on" : "off";
}

/** Asks for permission (must run from a tap) and subscribes this browser. */
export async function subscribe(vapidPublicKey: string): Promise<SavedSubscription> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Mitteilungen wurden nicht erlaubt.");
  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const sub =
    existing ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) }));
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) throw new Error("Unvollständige Push-Anmeldung.");
  return { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } };
}

/** Unsubscribes this browser; returns the endpoint that was active, if any. */
export async function unsubscribe(): Promise<string | null> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return null;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  return endpoint;
}

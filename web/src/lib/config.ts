// Runtime config. The Cloud Run server writes /config.js from env vars, so one image fits every project.
// No Firebase config (or ?demo in the URL) means demo mode with sample listings.
import type { FirebaseOptions } from "firebase/app";

export interface AppConfig {
  firebase: FirebaseOptions | null;
  /** Public VAPID key for Web Push; null = no push button. */
  vapidPublicKey: string | null;
}

declare global {
  interface Window {
    __LWR_CONFIG__?: Partial<AppConfig>;
  }
}

export function appConfig(): AppConfig {
  const c = window.__LWR_CONFIG__ ?? {};
  const forceDemo = new URLSearchParams(location.search).has("demo");
  return { firebase: forceDemo ? null : (c.firebase ?? null), vapidPublicKey: c.vapidPublicKey ?? null };
}

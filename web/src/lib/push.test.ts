import { describe, expect, it } from "vitest";
import { pushSupport, subscriptionId, urlBase64ToUint8Array, type PushEnv } from "./push";

const all: Omit<PushEnv, "userAgent" | "standalone"> = { hasServiceWorker: true, hasPushManager: true, hasNotification: true };
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const ANDROID = "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/141 Mobile Safari/537.36";

describe("pushSupport", () => {
  it("asks iPhone users to add the app to the home screen first", () => {
    expect(pushSupport({ userAgent: IPHONE, standalone: false, hasServiceWorker: true, hasPushManager: false, hasNotification: false })).toBe("install-first");
    expect(pushSupport({ userAgent: IPHONE, standalone: true, ...all })).toBe("ok");
  });
  it("works in Android Chrome without installing", () => {
    expect(pushSupport({ userAgent: ANDROID, standalone: false, ...all })).toBe("ok");
  });
  it("hides the button where push is missing", () => {
    expect(pushSupport({ userAgent: ANDROID, standalone: false, hasServiceWorker: true, hasPushManager: false, hasNotification: true })).toBe("unsupported");
  });
});

describe("helpers", () => {
  it("decodes URL-safe base64", () => {
    expect([...urlBase64ToUint8Array("AQID-_8")]).toEqual([1, 2, 3, 251, 255]);
  });
  it("derives a stable id per rater and endpoint", async () => {
    const a = await subscriptionId("philipp", "https://push.example/abc");
    expect(a).toMatch(/^philipp_[0-9a-f]{32}$/);
    expect(await subscriptionId("philipp", "https://push.example/abc")).toBe(a);
    expect(await subscriptionId("manuela", "https://push.example/abc")).not.toBe(a);
  });
});

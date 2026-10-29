// "Mitteilungen" toggle in the header: subscribes this device to the weekly "new batch" push.
import { useEffect, useState } from "react";
import type { FirebaseApp } from "../lib/firestoreStore";
import { currentPushState, subscribe, unsubscribe, type PushState } from "../lib/push";
import type { Rater } from "../lib/types";

const HINT: Partial<Record<PushState, string>> = {
  "install-first": "Auf dem iPhone erst „Teilen → Zum Home-Bildschirm“, dann in der App einschalten.",
  denied: "Mitteilungen sind blockiert. In den Einstellungen für „Wohn-Review“ wieder erlauben.",
};

export function PushButton({ fb, rater, vapidPublicKey }: { fb: FirebaseApp; rater: Rater; vapidPublicKey: string }) {
  const [state, setState] = useState<PushState | "busy" | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    currentPushState().then(setState, () => setState("unsupported"));
  }, []);

  if (state === null || state === "unsupported") return null;

  async function toggle() {
    setNote(null);
    if (state === "install-first" || state === "denied") {
      setNote(HINT[state] ?? null);
      return;
    }
    const was = state;
    setState("busy");
    try {
      if (was === "on") {
        const endpoint = await unsubscribe();
        if (endpoint) await fb.deletePushSubscription(rater, endpoint).catch(() => {});
        setState("off");
      } else {
        await fb.savePushSubscription(rater, await subscribe(vapidPublicKey));
        setState("on");
        setNote("Eingeschaltet. Eine Test-Mitteilung ist unterwegs.");
      }
    } catch (e) {
      setState(await currentPushState().catch(() => "off" as const));
      setNote(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <>
      <button onClick={toggle} disabled={state === "busy"} aria-pressed={state === "on"}>
        {state === "on" ? "Mitteilungen an" : "Mitteilungen"}
      </button>
      {note && (
        <span className="pushnote" role="status" onClick={() => setNote(null)}>
          {note}
        </span>
      )}
    </>
  );
}

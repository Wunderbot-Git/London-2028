// Demo mode without Firebase config; otherwise the production app (Google sign-in, Firestore).
import { Suspense, lazy, useMemo, useState } from "react";
import { appConfig } from "./lib/config";
import { demoStore, resetDemo } from "./lib/demoStore";
import { RATER_NAME, RATERS, type Rater } from "./lib/types";
import { Review } from "./views/Review";

// Firebase is only loaded when configured, so the demo stays small.
const Production = lazy(() => import("./Production"));

export function App() {
  const firebase = useMemo(() => appConfig().firebase, []);
  if (!firebase) return <Demo />;
  return (
    <Suspense fallback={<div className="app"><p className="foot">Lädt …</p></div>}>
      <Production options={firebase} />
    </Suspense>
  );
}

function Demo() {
  const [rater, setRater] = useState<Rater>("philipp");
  const [round, setRound] = useState(0);
  const other: Rater = rater === "philipp" ? "manuela" : "philipp";

  return (
    <Review
      key={`${rater}-${round}`}
      store={demoStore}
      rater={rater}
      who={
        <div className="seg" role="group" aria-label="Wer bewertet">
          {RATERS.map((r) => (
            <button key={r} aria-pressed={r === rater} onClick={() => setRater(r)}>
              {RATER_NAME[r]}
            </button>
          ))}
        </div>
      }
      summaryActions={
        <>
          <button className="cta" onClick={() => setRater(other)}>
            {rater === "philipp" ? "Manuela bewerten lassen" : "Zurück zu Philipp"}
          </button>
          <button
            className="cta alt"
            onClick={() => {
              resetDemo();
              setRound((n) => n + 1);
            }}
          >
            Von vorn
          </button>
        </>
      }
    />
  );
}

// Google sign-in against the allowlist in config/access, then the review for that account's rater.
import { useEffect, useMemo, useState } from "react";
import type { FirebaseOptions } from "firebase/app";
import type { User } from "firebase/auth";
import { FirebaseApp, type Session } from "./lib/firestoreStore";
import { RATER_NAME } from "./lib/types";
import { appConfig } from "./lib/config";
import { PushButton } from "./views/PushButton";
import { Review } from "./views/Review";

export default function Production({ options }: { options: FirebaseOptions }) {
  const fb = useMemo(() => new FirebaseApp(options), [options]);
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const vapidPublicKey = useMemo(() => appConfig().vapidPublicKey, []);

  useEffect(() => fb.onUser(setUser), [fb]);
  useEffect(() => {
    setSession(undefined);
    if (user) fb.session(user).then(setSession);
  }, [fb, user]);

  if (user === undefined || (user && session === undefined)) {
    return <div className="app"><p className="foot">Lädt …</p></div>;
  }

  if (!user || !session) {
    return (
      <div className="app">
        <div className="center">
          <h1>London Wohn-Review</h1>
          {user ? (
            <p>{user.email} ist nicht freigeschaltet.</p>
          ) : (
            <p>Wöchentliche Bewertung der Inserate rund um die DSL.</p>
          )}
          {error && <p className="err">{error}</p>}
          {user ? (
            <button className="cta alt" onClick={() => fb.signOut()}>
              Mit anderem Konto anmelden
            </button>
          ) : (
            <button
              className="cta"
              onClick={() => fb.signIn().catch((e) => setError(e instanceof Error ? e.message : String(e)))}
            >
              Mit Google anmelden
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <Review
      store={session.store}
      rater={session.rater}
      who={
        <div className="seg">
          <span>{RATER_NAME[session.rater]}</span>
          {vapidPublicKey && <PushButton fb={fb} rater={session.rater} vapidPublicKey={vapidPublicKey} />}
          <button onClick={() => fb.signOut()}>Abmelden</button>
        </div>
      }
    />
  );
}

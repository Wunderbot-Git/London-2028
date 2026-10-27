// Weekly review for one rater: works through the batch, then shows the summary.
// Each rater only loads their own ratings until they are done (spec §6.1 step 7).
import { useCallback, useEffect, useState } from "react";
import type { RatingsByRater } from "../lib/metrics";
import type { Store } from "../lib/store";
import { RATERS, type Batch, type Listing, type Profile, type Rater, type Rating } from "../lib/types";
import { weekNumber } from "../lib/week";
import { ListingCard, type Draft } from "./ListingCard";
import { Summary } from "./Summary";

interface Props {
  store: Store;
  rater: Rater;
  /** Rendered at the top right: rater switch in demo, account in production. */
  who: React.ReactNode;
  /** Extra buttons on the summary screen. */
  summaryActions?: React.ReactNode;
}

type Loaded = {
  batch: Batch;
  listings: Listing[];
  mine: Record<string, Rating>;
};

export function Review({ store, rater, who, summaryActions }: Props) {
  const [data, setData] = useState<Loaded | null | "none">(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<{ byRater: RatingsByRater; profile: Profile | null } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setSummary(null);
    try {
      const batch = await store.currentBatch();
      if (!batch || !batch.listingIds.length) return setData("none");
      const [listings, mine] = await Promise.all([
        store.listings(batch.listingIds),
        store.ratings(rater, batch.listingIds),
      ]);
      setData({ batch, listings, mine });
    } catch (e) {
      setError(errorText(e));
    }
  }, [store, rater]);

  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  const loaded = data && data !== "none" ? data : null;
  const pending = loaded ? loaded.listings.filter((l) => !loaded.mine[l.id]) : [];
  const current = pending[0];
  const done = !!loaded && !current;

  // Once the batch is done: mark it completed and load both raters' ratings for the summary.
  useEffect(() => {
    if (!done || !loaded || summary) return;
    const data = loaded;
    (async () => {
      try {
        if (!data.batch.completed[rater]) await store.markCompleted(data.batch.week, rater);
        const ids = data.batch.listingIds;
        const [all, profile] = await Promise.all([
          Promise.all(RATERS.map((r) => store.ratings(r, ids))),
          store.latestProfile(),
        ]);
        const batch = await store.currentBatch();
        if (batch) setData({ ...data, batch });
        setSummary({ byRater: Object.fromEntries(RATERS.map((r, i) => [r, all[i]])), profile });
      } catch (e) {
        setError(errorText(e));
      }
    })();
  }, [done, loaded, summary, store, rater]);

  async function save(listing: Listing, d: Draft | null) {
    if (!loaded) return;
    const rating: Rating = {
      listingId: listing.id,
      rater,
      score: d?.score ?? null,
      tags: d?.tags ?? [],
      note: d?.note ?? "",
      predictionAtRating: listing.prediction?.score ?? null,
      createdAt: new Date().toISOString(),
    };
    setBusy(true);
    setError(null);
    try {
      await store.saveRating(rating);
      setData({ ...loaded, mine: { ...loaded.mine, [listing.id]: rating } });
      window.scrollTo({ top: 0 });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const total = loaded ? loaded.listings.length : 0;
  const position = total - pending.length;
  const week = loaded ? `KW ${weekNumber(loaded.batch.week)}` : "";

  return (
    <div className="app">
      <div className="top">
        <div className="toprow">
          <span className="num">
            {week}
            {total ? (current ? ` · ${position + 1} von ${total}` : " · Fertig") : ""}
          </span>
          {who}
        </div>
        <div className="line">
          <i style={{ width: total ? `${(position / total) * 100}%` : 0 }} />
        </div>
      </div>

      <main>
        {error && <p className="err">{error}</p>}
        {data === null && !error && <p className="foot">Lädt …</p>}
        {data === "none" && (
          <div className="center">
            <h1>Noch kein Stapel.</h1>
            <p>Der Wochenstapel kommt sonntags. Dann geht es hier weiter.</p>
          </div>
        )}
        {current && (
          <ListingCard
            key={current.id}
            listing={current}
            busy={busy}
            onDone={(d) => save(current, d)}
            onSkip={() => save(current, null)}
          />
        )}
        {done && summary && loaded && (
          <Summary
            week={loaded.batch.week}
            rater={rater}
            listings={loaded.listings}
            byRater={summary.byRater}
            profile={summary.profile}
            otherDone={RATERS.every((r) => r === rater || !!loaded.batch.completed[r])}
            actions={summaryActions}
          />
        )}
      </main>
      {store.demo && <p className="foot">Demo mit Beispielinseraten · Prognosen sind Platzhalter</p>}
    </div>
  );
}

function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return `Das hat nicht geklappt: ${msg}`;
}

// Weekly wrap-up (spec §5.5 view 2, §6.3, §6.4): metrics, learned rules, Philipp / Manuela / prediction table.
import { agreementRate, disagreements, favourite, predictionMetrics, tagHints, type RatingsByRater } from "../lib/metrics";
import { weekNumber } from "../lib/week";
import { RATER_NAME, type Listing, type Profile, type Rater } from "../lib/types";

interface Props {
  week: string;
  rater: Rater;
  listings: Listing[];
  byRater: RatingsByRater;
  profile: Profile | null;
  otherDone: boolean;
  actions: React.ReactNode;
}

export function Summary({ week, rater, listings, byRater, profile, otherDone, actions }: Props) {
  const mine = Object.values(byRater[rater] ?? {});
  const m = predictionMetrics(mine);
  const rated = mine.filter((r) => r.score != null).length;
  const ids = listings.map((l) => l.id);
  const split = new Set(disagreements(ids, byRater));
  const agree = agreementRate(ids, byRater);
  const fav = favourite(mine, listings);
  const other: Rater = rater === "philipp" ? "manuela" : "philipp";

  const learn = profile?.rules?.length ? profile.rules : tagHints(mine);
  const notes = [...learn];
  if (split.size) notes.push(`Bei ${split.size} ${split.size > 1 ? "Inseraten" : "Inserat"} seid ihr euch uneinig.`);
  if (!notes.length) notes.push("Noch zu wenig Gründe. Nach zwei, drei Wochen wird das Muster sichtbar.");

  const cell = (score: number | null | undefined) =>
    score != null ? <span className="c">{score}</span> : <span className="c dim">–</span>;

  return (
    <section className="sum enter">
      <h2>
        Woche {weekNumber(week)} erledigt.
        <br />
        <span>{fav ? `Favorit: ${fav.address}.` : "Nichts bewertet."}</span>
      </h2>

      <div className="big">
        <div>
          <b className="num">{rated}</b>
          <small>bewertet</small>
        </div>
        <div>
          <b className="num">{m.n ? `${m.hitsWithin1}/${m.n}` : "–"}</b>
          <small>Prognose ±1</small>
        </div>
        <div>
          <b className="num">{m.mae == null ? "–" : m.mae.toFixed(1)}</b>
          <small>Ø Abweichung</small>
        </div>
      </div>

      <div className="sec">
        <h3>{profile?.rules?.length ? `Was das Modell gelernt hat · Profil v${profile.version}` : "Was das Modell lernt"}</h3>
        <ul className="learn">
          {notes.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      </div>

      <div className="sec">
        <h3>Alle Inserate</h3>
        <div className="tbl">
          <div className="tr h">
            <span></span>
            <span className="c dim">P</span>
            <span className="c dim">M</span>
            <span className="c dim">KI</span>
          </div>
          {listings.map((l) => (
            <div className="tr" key={l.id}>
              <span className={split.has(l.id) ? "split" : undefined}>{l.address}</span>
              {cell(byRater.philipp?.[l.id]?.score)}
              {cell(byRater.manuela?.[l.id]?.score)}
              <span className="c dim">{l.prediction?.score ?? "–"}</span>
            </div>
          ))}
        </div>
        {agree != null && <p className="note">Einigkeit (±1): {Math.round(agree * 100)} %</p>}
        {!otherDone && <p className="note">{RATER_NAME[other]} ist mit dieser Woche noch nicht fertig.</p>}
      </div>

      <div className="btns">{actions}</div>
    </section>
  );
}

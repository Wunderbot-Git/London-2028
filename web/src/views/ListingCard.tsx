// One listing per screen (spec §6.1). The prediction stays hidden until the listing is rated.
import { useState } from "react";
import {
  availableLabel,
  commuteLines,
  deviationLabel,
  flagLabel,
  furnishedLabel,
  gbp,
  hue,
  letLabel,
  postcodeDistrict,
  sourceLabel,
  weeklyPrice,
} from "../lib/format";
import { SCORE_WORD, TAGS, type Listing } from "../lib/types";

export interface Draft {
  score: number;
  tags: string[];
  note: string;
}

interface Props {
  listing: Listing;
  busy: boolean;
  onDone: (d: Draft) => void;
  onSkip: () => void;
}

export function ListingCard({ listing: L, busy, onDone, onSkip }: Props) {
  const [score, setScore] = useState<number | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [note, setNote] = useState("");

  const commute = commuteLines(L.commute);
  const src = sourceLabel(L.source);
  const facts = [
    `${L.beds} Schlafzimmer`,
    `${L.baths} ${L.baths === 1 ? "Bad" : "Bäder"}`,
    L.garden == null ? null : L.garden ? "Garten" : "Kein Garten",
  ].filter(Boolean);
  const line2 = [commute.main && `${commute.main} zur Schule`, letLabel(L)].filter(Boolean).join(" · ");
  const pred = L.prediction?.score ?? null;
  const toggle = (t: string) => setTags((xs) => (xs.includes(t) ? xs.filter((x) => x !== t) : [...xs, t]));

  return (
    <article className="card enter">
      <div className="hero" style={{ ["--h" as string]: hue(L.id) }}>
        {L.sample && <span className="sample">Beispiel</span>}
        <span className="src">{src}</span>
        <div className="pc">{postcodeDistrict(L.postcode)}</div>
        <div className="place">
          {L.address}
          {L.area ? `, ${L.area}` : ""}
        </div>
      </div>

      <div>
        <p className="price num">
          {gbp(L.priceMonthly)}
          <span>pro Monat{L.billsIncluded ? ", alles inklusive" : ""}</span>
        </p>
      </div>

      <div className="facts">
        <p>{facts.join(" · ")}</p>
        <p className="q">{line2}</p>
        {(L.flags ?? []).map((f) => (
          <p className="warn" key={f}>
            {flagLabel(f)}
          </p>
        ))}
      </div>

      <details>
        <summary>
          Details <span className="chev">›</span>
        </summary>
        <dl>
          <dt>Einrichtung</dt>
          <dd>{furnishedLabel(L.furnished)}</dd>
          {commute.alt && (
            <>
              <dt>Alternativ</dt>
              <dd>{commute.alt}</dd>
            </>
          )}
          <dt>Verfügbar</dt>
          <dd>{availableLabel(L.availableFrom)}</dd>
          {L.highlight && (
            <>
              <dt>Besonderheit</dt>
              <dd>{L.highlight}</dd>
            </>
          )}
          <dt>Energieklasse</dt>
          <dd>{L.epc || "–"}</dd>
          <dt>Pro Woche</dt>
          <dd className="num">{gbp(weeklyPrice(L.priceMonthly))}</dd>
        </dl>
        {L.url ? (
          <a className="ext" href={L.url} target="_blank" rel="noopener noreferrer">
            Inserat auf {src} ansehen ↗
          </a>
        ) : (
          <span className="ext dim">{L.sample ? "Erfundenes Beispiel" : "Kein Link"}</span>
        )}
      </details>

      <section className="rate">
        <p className="ask">Wie passend?</p>
        <div className="dots" role="group" aria-label="Bewertung von 1 bis 5">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              className="dot"
              aria-pressed={score === n}
              aria-label={`${n}, ${SCORE_WORD[n]}`}
              onClick={() => setScore(n)}
            >
              {n}
            </button>
          ))}
        </div>
        <div className="verdict">{score ? SCORE_WORD[score] : ""}</div>

        {score != null && (
          <div className="after">
            {pred != null ? (
              <>
                <div className="compare">
                  <span className="p">Prognose {pred}</span>
                  <Deviation score={score} pred={pred} />
                </div>
                {L.prediction?.rationale && <p className="why">{L.prediction.rationale}</p>}
              </>
            ) : (
              <p className="why">Für dieses Inserat gibt es noch keine Prognose.</p>
            )}
            <div className="tags">
              {TAGS.map((t) => (
                <button key={t} className="tag" aria-pressed={tags.includes(t)} onClick={() => toggle(t)}>
                  {t}
                </button>
              ))}
            </div>
            <input
              className="field"
              type="text"
              placeholder="Notiz"
              autoComplete="off"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <button className="cta" disabled={busy} onClick={() => onDone({ score, tags, note: note.trim() })}>
              Weiter
            </button>
          </div>
        )}
        {score == null && (
          <button className="quiet" disabled={busy} onClick={onSkip}>
            Überspringen
          </button>
        )}
      </section>
    </article>
  );
}

function Deviation({ score, pred }: { score: number; pred: number }) {
  const d = deviationLabel(score, pred);
  return <span className={d.hit ? "hit" : "miss"}>{d.text}</span>;
}

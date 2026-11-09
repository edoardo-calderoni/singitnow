import { Trophy } from "lucide-react";
import { ScoreEntry } from "../shared/api";
import { Avatar } from "../shared/Avatar";

/** Classifica della serata: miglior voto d'intonazione di ogni cantante. */
export function Ranking({ ranking, name }: { ranking: ScoreEntry[]; name: string }) {
  if (!ranking.length) return null;
  return (
    <>
      <h2 className="m-h2">Classifica della serata</h2>
      <ol className="m-ranking">
        {ranking.map((r, i) => (
          <li key={r.singer} className={r.singer === name ? "me" : ""}>
            <span className="pos">{i === 0 ? <Trophy size={16} /> : `${i + 1}°`}</span>
            <Avatar name={r.singer} className="xs" />
            <div className="who">
              <b className="ellipsis">{r.singer}</b>
              <span className="muted ellipsis">{r.title}</span>
            </div>
            <b className="score">{r.score}</b>
          </li>
        ))}
      </ol>
    </>
  );
}

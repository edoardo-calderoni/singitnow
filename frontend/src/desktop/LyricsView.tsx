import { memo, useMemo } from "react";
import type { LyricLine } from "../shared/api";
import { activeIndex, switchTimes, wordFill } from "../shared/lyrics";

function Line({ line, t, dim }: { line: LyricLine; t: number; dim?: boolean }) {
  return (
    <div className={`lyric-line ${dim ? "next" : "current"}`}>
      {line.words.map((w, i) => {
        const p = dim ? 0 : wordFill(w, t);
        return (
          <span key={i} className="lyric-word" style={{ ["--p" as string]: `${(p * 100).toFixed(1)}%` }}>
            {w.t}
          </span>
        );
      })}
    </div>
  );
}

/**
 * Testo karaoke a due righe: la riga corrente si colora parola per parola
 * mentre viene cantata; sotto, la riga successiva. Nelle pause strumentali
 * mostra un conto alla rovescia verso la prossima strofa.
 */
export const LyricsView = memo(function LyricsView({ lines, t }: { lines: LyricLine[]; t: number }) {
  const times = useMemo(() => switchTimes(lines), [lines]);
  if (!lines.length) {
    return (
      <div className="lyrics">
        <div className="lyric-hint">Testo non disponibile per questo brano</div>
      </div>
    );
  }
  const i = activeIndex(times, t);
  const cur = i >= 0 ? lines[i]! : null;
  const next = lines[i + 1];

  // Pausa lunga: la riga corrente è finita da un po' e la prossima è lontana.
  const gapStart = cur ? cur.end : 0;
  const inGap = next && t > gapStart + 1.5 && next.start - t > 3;
  if (!cur || inGap) {
    const target = next ?? lines[0]!;
    const remaining = target.start - t;
    const total = Math.max(target.start - gapStart, 0.1);
    return (
      <div className="lyrics">
        {remaining > 0 && remaining < 60 && (
          <div className="lyric-wait">
            <div className="dots">
              {[3, 2, 1].map((n) => (
                <span key={n} className={remaining <= n ? "on" : ""} />
              ))}
            </div>
            <div className="wait-bar">
              <div style={{ width: `${Math.min(100, (1 - remaining / total) * 100)}%` }} />
            </div>
          </div>
        )}
        <Line line={target} t={t} dim />
      </div>
    );
  }
  return (
    <div className="lyrics">
      <Line line={cur} t={t} />
      {next ? <Line line={next} t={t} dim /> : <div className="lyric-line next">&nbsp;</div>}
    </div>
  );
});

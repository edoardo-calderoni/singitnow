import { useCallback, useRef, useState } from "react";
import { Avatar } from "../shared/Avatar";

interface Bubble {
  key: number;
  name: string;
  x: number; // posizione orizzontale di partenza (0..1)
  drift: number; // deriva laterale durante la salita (vw)
  dur: number; // durata della salita (s)
  size: number; // scala della bolla
}

const MAX_BUBBLES = 80; // con tantissimi applausi si tengono le bolle più recenti

/** Applausi dai telefoni: ogni applauso è una bolla che sale e svanisce (come i cuori nelle live). */
export function useApplause() {
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const seq = useRef(0);

  const push = useCallback((name: string) => {
    const b: Bubble = {
      key: ++seq.current,
      name,
      x: Math.random(),
      drift: (Math.random() - 0.5) * 5,
      dur: 2.6 + Math.random() * 1.2,
      size: 0.85 + Math.random() * 0.35,
    };
    setBubbles((prev) => [...prev, b].slice(-MAX_BUBBLES));
    window.setTimeout(() => setBubbles((prev) => prev.filter((x) => x.key !== b.key)), b.dur * 1000 + 100);
  }, []);

  return { bubbles, push };
}

export function ApplauseLayer({ bubbles }: { bubbles: Bubble[] }) {
  if (!bubbles.length) return null;
  return (
    <div className="applause" aria-hidden>
      {bubbles.map((b) => (
        <div
          key={b.key}
          className="clap"
          style={
            {
              left: `${b.x * 100}%`,
              "--drift": `${b.drift}vw`,
              "--dur": `${b.dur}s`,
              "--size": b.size,
            } as React.CSSProperties
          }
        >
          <Avatar name={b.name} className="clap-avatar" />
          <span className="clap-icon">👏</span>
        </div>
      ))}
    </div>
  );
}

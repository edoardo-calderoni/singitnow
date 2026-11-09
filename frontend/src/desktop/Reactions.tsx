import { useCallback, useState } from "react";
import { Avatar } from "../shared/Avatar";

/** Reazione dal telefono: l'emoji sale dal lato sinistro della TV con la foto di chi la manda. */
interface Flyer {
  key: number;
  name: string;
  emoji: string;
  x: number; // 0..1 nella colonna
  drift: number; // vw
  dur: number; // s
  size: number;
  spin: number; // gradi
}

const MAX = 60;
let seq = 0;

export function useReactions() {
  const [items, setItems] = useState<Flyer[]>([]);
  const push = useCallback((name: string, emoji: string) => {
    const f: Flyer = {
      key: ++seq,
      name,
      emoji,
      x: Math.random(),
      drift: (Math.random() - 0.5) * 6,
      dur: 3 + Math.random() * 0.8,
      size: 0.85 + Math.random() * 0.4,
      spin: (Math.random() - 0.5) * 40,
    };
    setItems((prev) => [...prev, f].slice(-MAX));
    window.setTimeout(() => setItems((prev) => prev.filter((x) => x.key !== f.key)), f.dur * 1000 + 100);
  }, []);
  return { items, push };
}

export function ReactionLayer({ items }: { items: Flyer[] }) {
  if (!items.length) return null;
  return (
    <div className="reactions" aria-hidden>
      {items.map((f) => (
        <div
          key={f.key}
          className="reaction"
          style={
            {
              left: `${f.x * 100}%`,
              "--drift": `${f.drift}vw`,
              "--dur": `${f.dur}s`,
              "--size": f.size,
              "--spin": `${f.spin}deg`,
            } as React.CSSProperties
          }
        >
          <span className="reaction-emoji">{f.emoji}</span>
          <Avatar name={f.name} className="reaction-avatar" />
        </div>
      ))}
    </div>
  );
}

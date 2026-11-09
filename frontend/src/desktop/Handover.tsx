import { useEffect, useRef, useState } from "react";
import { Mic2 } from "lucide-react";
import { Entry } from "../shared/api";
import { Avatar } from "../shared/Avatar";
import { singersOf } from "../shared/queue";

const SHOW_MS = 5000;

interface Pass {
  key: number;
  from: Entry;
  to: Entry;
}

const people = (e: Entry) =>
  [e.singer, e.partner]
    .map((n) => (n ?? "").trim().toLocaleLowerCase())
    .filter(Boolean)
    .sort()
    .join("|");

/**
 * «Anna passa il microfono a Marco!»: sulla TV, quando finisce un brano e il successivo lo canta
 * qualcun altro (solo in Karaoke, e solo se entrambi hanno un nome).
 */
export function useHandover(now: Entry | null, karaoke: boolean) {
  const [pass, setPass] = useState<Pass | null>(null);
  const prev = useRef<Entry | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    const before = prev.current;
    prev.current = now;
    if (!karaoke || !before || !now || before.id === now.id) return;
    if (!people(before) || !people(now) || people(before) === people(now)) return;
    const key = ++seq.current;
    setPass({ key, from: before, to: now });
    const id = window.setTimeout(() => setPass((p) => (p?.key === key ? null : p)), SHOW_MS);
    return () => window.clearTimeout(id);
    // si guarda solo il cambio di brano
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now?.id]);
  return pass;
}

export function HandoverBanner({ pass }: { pass: Pass | null }) {
  if (!pass) return null;
  return (
    <div className="handover" key={pass.key}>
      <div className="handover-faces">
        <Avatar name={pass.from.singer} />
        <Mic2 size={30} className="handover-mic" />
        <Avatar name={pass.to.singer} />
      </div>
      <div className="handover-text">
        <b>{singersOf(pass.from)}</b> passa il microfono a <b className="grad-text">{singersOf(pass.to)}</b>!
      </div>
    </div>
  );
}

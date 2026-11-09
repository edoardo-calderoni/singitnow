import { useEffect, useRef } from "react";

/**
 * Musica di sottofondo della schermata principale (media/sounds/background.mp3): in loop, a volume
 * molto basso. Sfuma quando parte un brano (o compaiono i punteggi o il vincitore) e torna, sempre
 * in dissolvenza, quando si rientra nella schermata principale, riprendendo da dove era rimasta.
 * Se il file non c'è non succede niente.
 */
const URL = "/sounds/background.mp3";
const VOLUME = 0.08; // molto basso: si sente appena, non disturba chi parla
const FADE_IN = 3; // s
const FADE_OUT = 2; // s

export function BackgroundMusic({ active }: { active: boolean }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const anim = useRef(0);

  useEffect(() => {
    const a = new Audio(URL);
    a.loop = true;
    a.volume = 0;
    a.preload = "auto";
    audio.current = a;
    return () => {
      cancelAnimationFrame(anim.current);
      a.pause();
      a.src = "";
      audio.current = null;
    };
  }, []);

  useEffect(() => {
    const a = audio.current;
    if (!a) return;
    cancelAnimationFrame(anim.current);
    const from = a.volume;
    const to = active ? VOLUME : 0;
    const secs = (active ? FADE_IN : FADE_OUT) * (Math.abs(to - from) / VOLUME || 0);
    if (active && a.paused) a.play().catch(() => {}); // senza file (404) o audio bloccato: niente
    const t0 = performance.now();
    const step = () => {
      const k = secs > 0 ? Math.min(1, (performance.now() - t0) / (secs * 1000)) : 1;
      a.volume = Math.max(0, Math.min(1, from + (to - from) * k));
      if (k < 1) anim.current = requestAnimationFrame(step);
      else if (!active) a.pause(); // sfumata: si ferma (e riprende da qui la prossima volta)
    };
    step();
  }, [active]);

  return null;
}

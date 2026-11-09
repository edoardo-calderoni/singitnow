import { useSyncExternalStore } from "react";

/** Modalità della serata (scelta da un amministratore o dal PC, condivisa in tempo reale). */
export type Mode = "karaoke" | "jukebox" | "dj";

interface State {
  mode: Mode;
  dj: string; // DJ della serata (modalità DJ), "" se non ancora eletto
  djAt: number; // istante dell'elezione del DJ
}

let state: State = { mode: "karaoke", dj: "", djAt: 0 };
const subs = new Set<() => void>();

/** Dati dell'evento "mode" del PC: { mode, dj }. */
export function setMode(data: { mode?: string; dj?: string; dj_at?: number } | null | undefined) {
  const m = data?.mode;
  const next: State = {
    mode: m === "jukebox" || m === "dj" ? m : "karaoke",
    dj: (data?.dj ?? "").trim(),
    djAt: Number(data?.dj_at) || 0,
  };
  if (next.mode === state.mode && next.dj === state.dj && next.djAt === state.djAt) return;
  state = next;
  subs.forEach((f) => f());
}

function useState_(): State {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => state,
  );
}

export const useMode = (): Mode => useState_().mode;
/** Modalità attuale, fuori dai componenti (per i calcoli). */
export const currentMode = (): Mode => state.mode;

/** DJ della serata ("" se non eletto o se non si è in modalità DJ). */
export const useDj = (): string => {
  const s = useState_();
  return s.mode === "dj" ? s.dj : "";
};

/** Istante dell'elezione del DJ (identifica l'elezione). */
export const useDjAt = (): number => useState_().djAt;

/**
 * true in Jukebox e in DJ: si ascolta con la voce originale, niente "canta", niente applausi
 * né limite di un brano a testa.
 */
export const useJukebox = () => useMode() !== "karaoke";

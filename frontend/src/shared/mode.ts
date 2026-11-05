import { useSyncExternalStore } from "react";

/** Modalità della serata (scelta da un amministratore, condivisa in tempo reale dal PC). */
export type Mode = "karaoke" | "jukebox";

let mode: Mode = "karaoke";
const subs = new Set<() => void>();

export function setMode(m: Mode) {
  if (m === mode) return;
  mode = m;
  subs.forEach((f) => f());
}

export function useMode(): Mode {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => mode,
  );
}

/** true in modalità Jukebox: si ascolta con la voce originale, niente "canta", niente applausi. */
export const useJukebox = () => useMode() === "jukebox";

import { useSyncExternalStore } from "react";

/** Settaggi della serata scelti dal PC (pannello «Settaggi»), condivisi in tempo reale. */
export interface Settings {
  autoplay: boolean; // «Riproduzione automatica»
  locked: boolean; // «Blocca inserimenti»: aggiungono brani solo il PC e gli amministratori
  record: boolean; // «Registra le esibizioni»
  auto_key: boolean; // «Adatta la tonalità automaticamente»
}

let settings: Settings | null = null; // null finché il PC non li ha comunicati
const subs = new Set<() => void>();

export function setSettings(s: Settings) {
  settings = { autoplay: !!s?.autoplay, locked: !!s?.locked, record: !!s?.record, auto_key: !!s?.auto_key };
  subs.forEach((f) => f());
}

export function useSettings(): Settings | null {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => settings,
  );
}

import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { VoiceState } from "./api";

/**
 * Voce dei microfoni e autotune (stato condiviso fra TV e telefoni degli amministratori): arriva
 * dal PC all'apertura e con l'evento "voice" a ogni cambiamento.
 */
let current: VoiceState | null = null;
const listeners = new Set<(v: VoiceState) => void>();

export function publishVoice(v: VoiceState) {
  current = v;
  listeners.forEach((l) => l(v));
}

export function useVoice(): VoiceState | null {
  const [v, setV] = useState(current);
  useEffect(() => {
    listeners.add(setV);
    api.voice().then(publishVoice).catch(() => {});
    return () => void listeners.delete(setV);
  }, []);
  return v;
}

/** Cambia un'impostazione: si vede subito; l'intensità si manda al PC al massimo ogni 150 ms. */
export function useVoiceSetter(onError: (m: string) => void) {
  const timer = useRef<number | undefined>(undefined);
  const pending = useRef<Partial<VoiceState>>({});
  const err = useRef(onError);
  err.current = onError;
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (change: Partial<Pick<VoiceState, "engine" | "autotune" | "strength">>) => {
    if (current) publishVoice({ ...current, ...change, ...(change.autotune ? { engine: true } : {}) });
    pending.current = { ...pending.current, ...change };
    if (timer.current !== undefined) return;
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      const send = pending.current;
      pending.current = {};
      api
        .setVoice(send)
        .then(publishVoice)
        .catch((e) => err.current(e.message));
    }, 150);
  };
}

/** Cosa sta facendo l'autotune adesso (per l'indicatore sotto i controlli). */
export function correctionText(v: VoiceState): string {
  if (!v.autotune || !v.running) return "";
  if (!v.singing) return "Autotune pronto: in attesa della voce";
  if (v.correction_cents < 5) return "Autotune: voce già intonata";
  return `Autotune: corregge di ~${v.correction_cents} cent`;
}

/** Intensità dell'autotune a parole. */
export function strengthLabel(s: number): string {
  if (s < 0.34) return "Leggero";
  if (s < 0.75) return "Medio";
  return "Robotico";
}


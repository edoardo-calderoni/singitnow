import { useEffect, useRef, useState } from "react";
import { api, Mic } from "./api";

/**
 * Microfoni per cantare (uno o due) con volume e muto di Windows, condivisi tra TV e telefoni
 * degli amministratori. Lo stato arriva dal PC: all'apertura, con l'evento "mics" quando qualcuno
 * li regola e ogni pochi secondi (microfoni collegati/scollegati, regolazioni fatte da Windows).
 */
let current: Mic[] | null = null;
let lastLocal = -Infinity; // ultima regolazione fatta da questo schermo
const listeners = new Set<(m: Mic[]) => void>();

export function publishMics(m: Mic[]) {
  current = m;
  listeners.forEach((l) => l(m));
}

export function useMics(active = true): Mic[] | null {
  const [mics, setMics] = useState(current);
  useEffect(() => {
    if (!active) return;
    listeners.add(setMics);
    // appena regolato da qui: si aspetta un attimo a rileggere, il cursore non deve saltare indietro
    const load = () =>
      api
        .mics()
        .then((r) => performance.now() - lastLocal > 1500 && publishMics(r.mics))
        .catch(() => {});
    load();
    const id = window.setInterval(load, 5000);
    return () => {
      listeners.delete(setMics);
      window.clearInterval(id);
    };
  }, [active]);
  return mics;
}

/**
 * Regolazione di un microfono: si vede subito e si manda al PC al massimo ogni 150 ms
 * (trascinando il cursore non si inonda il PC di richieste).
 */
export function useMicSetter(onError: (msg: string) => void) {
  const pending = useRef<Map<number, { volume?: number; muted?: boolean }>>(new Map());
  const timer = useRef<number | undefined>(undefined);
  const errRef = useRef(onError);
  errRef.current = onError;
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (index: number, change: { volume?: number; muted?: boolean }) => {
    lastLocal = performance.now();
    if (current) publishMics(current.map((m) => (m.index === index ? { ...m, ...change } : m)));
    pending.current.set(index, { ...pending.current.get(index), ...change });
    if (timer.current !== undefined) return;
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      const batch = [...pending.current];
      pending.current.clear();
      batch.forEach(([i, c]) =>
        api
          .setMic(i, c)
          .then((r) => publishMics(r.mics))
          .catch((e) => errRef.current(e.message)),
      );
    }, 150);
  };
}

/** Con due microfoni si distinguono dal colore (come quelli veri): il primo è il rosso, il secondo il blu. */
export const MIC_NAMES = ["Microfono Rosso", "Microfono Blu"];

/** Colore del microfono di chi canta: chi ha prenotato prende il rosso, chi si è unito in duetto il blu. */
export const MIC_COLORS = ["Rosso", "Blu"];

/**
 * Quanti microfoni per cantare sono collegati al PC (0 = non si sa ancora). Si chiede al PC solo
 * quando serve (`active`), cioè quando c'è da dire a qualcuno quale microfono prendere o passare.
 */
export function useMicCount(active: boolean): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    api
      .micCount()
      .then((r) => alive && setCount(r.count))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [active]);
  return count;
}

/** Nome da mostrare: «Microfono» o, con due microfoni, «Microfono Rosso» / «Microfono Blu». */
export function micLabel(m: Mic, count: number): string {
  return count > 1 ? (MIC_NAMES[m.index] ?? `Microfono ${m.index + 1}`) : "Microfono";
}

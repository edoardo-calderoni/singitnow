import { useEffect, useState } from "react";
import { Entry, PlaylistState } from "./api";
import { LivePlayer, playerTime } from "./live";
import { currentMode } from "./mode";
import { competitionEnabled } from "./competition";

/** Pausa stimata tra un brano e il successivo (caricamento audio sulla TV). */
export const GAP = 6;

/** Ridisegna il componente ogni `ms` millisecondi (per i conti alla rovescia). */
export function useTick(ms = 1000) {
  const [, set] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => set((n) => n + 1), ms);
    return () => window.clearInterval(id);
  }, [ms]);
}

/** Secondi che mancano alla fine del brano in corso sulla TV. */
export function currentRemaining(playlist: PlaylistState, player: LivePlayer): number {
  const now = playlist.now_playing;
  if (!now?.song) return 0;
  if (player && player.state.song_id === now.song.id) {
    return Math.max(0, (player.state.duration || now.song.duration) - playerTime(player));
  }
  return now.song.duration; // il player non ha ancora comunicato: brano appena partito
}

/**
 * In Karaoke, dopo ogni brano, il pannello dei punteggi: statistiche che crescono, rullo di tamburi,
 * voto con la reazione del pubblico, 4 s di pausa e dissolvenza (circa).
 */
export const RESULTS_SECONDS = 20;
/** Poi la classifica della competizione. */
export const BOARD_SECONDS = 10;

/**
 * Pausa fra la fine di un brano e l'inizio del successivo: caricamento e, in Karaoke con la
 * competizione accesa, le schermate dei punteggi e della classifica (senza competizione non ci sono).
 */
export function betweenSongs(): number {
  if (currentMode() !== "karaoke" || !competitionEnabled()) return GAP;
  return GAP + RESULTS_SECONDS + BOARD_SECONDS;
}

/**
 * Tra quanti secondi inizierà ogni brano: quelli in coda (stessa posizione di playlist.entries) e
 * quelli ancora in preparazione (stessa posizione di playlist.waiting).
 *
 * Stesso ordine del PC: un brano in preparazione riprende il suo turno davanti ai brani richiesti
 * dopo di lui, se a quel punto sarà già pronto; altrimenti quelli passano avanti e lui entra quando
 * è pronto (in fondo).
 */
export function queueTimeline(playlist: PlaylistState, player: LivePlayer): { entries: number[]; waiting: number[] } {
  const pause = betweenSongs();
  let t = playlist.now_playing ? currentRemaining(playlist, player) + pause : 0;
  const waiting: number[] = playlist.waiting.map(() => -1);
  // quando sarà pronto ogni brano in preparazione: il PC li prepara uno alla volta, in ordine, quindi
  // un brano in attesa non può essere pronto prima di quelli davanti (conta anche l'importazione in
  // corso, se il PC non ha ancora mandato la sua stima)
  const ready: number[] = [];
  playlist.waiting.forEach((w, i) => {
    const own = prepRemaining(w.song);
    const known = !!w.song?.eta && w.song.eta > 0;
    const prev = i > 0 ? ready[i - 1] : 0;
    ready.push(known ? Math.max(own, prev) : prev + own);
  });
  const place = (i: number, at: number) => {
    waiting[i] = at;
    t = at + (playlist.waiting[i].song?.duration ?? 0) + pause;
  };
  const entries = playlist.entries.map((e) => {
    playlist.waiting.forEach((w, i) => {
      // richiesto prima di questo brano e pronto quando toccherebbe a lui: passa davanti
      if (waiting[i] < 0 && (w.requested_at ?? Infinity) < e.added_at && ready[i] <= t) place(i, t);
    });
    const start = t;
    t += (e.song?.duration ?? 0) + pause;
    return start;
  });
  // gli altri entrano in fondo, appena pronti
  playlist.waiting.forEach((_, i) => {
    if (waiting[i] < 0) place(i, Math.max(t, ready[i]));
  });
  return { entries, waiting };
}

/** Tra quanti secondi inizierà ogni brano in coda (stessa posizione di playlist.entries). */
export function entryStarts(playlist: PlaylistState, player: LivePlayer): number[] {
  return queueTimeline(playlist, player).entries;
}

// ultima stima ricevuta per ogni brano e quando è arrivata: tra un aggiornamento e l'altro del PC
// (i dati della coda non cambiano mentre il brano si prepara) il tempo scende da solo
const prepSeen = new Map<string, { eta: number; at: number }>();

/**
 * Secondi che mancano alla fine della preparazione di un brano: stima del PC (o, se ancora
 * sconosciuta, dalla durata), che scende secondo per secondo finché non ne arriva una nuova.
 */
export function prepRemaining(song: { id?: string; eta?: number; duration?: number } | null | undefined): number {
  if (!song) return 0;
  // download + separazione della voce + testo, in media, se il PC non ha ancora una stima
  const est = song.eta && song.eta > 0 ? song.eta : 20 + 0.7 * (song.duration || 240);
  if (!song.id) return est;
  const now = Date.now() / 1000;
  const prev = prepSeen.get(song.id);
  if (!prev || Math.abs(prev.eta - est) > 0.05) {
    prepSeen.set(song.id, { eta: est, at: now });
    return est;
  }
  return Math.max(1, prev.eta - (now - prev.at)); // mai zero finché non è pronto davvero
}

/** «4:05»: conto alla rovescia in minuti e secondi. */
export function fmtClock(s: number): string {
  const t = Math.max(0, Math.round(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const ss = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export function fmtWait(s: number): string {
  if (s < 60) return "meno di un minuto";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

const same = (a: string | undefined, b: string) => !!a && !!b && a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

/** `name` canta questo brano (l'ha prenotato o si è unito in duetto)? */
export function singsIn(e: Pick<Entry, "singer" | "partner"> | null | undefined, name: string): boolean {
  return !!e && (same(e.singer, name) || same(e.partner, name));
}

/** Chi canta: «Anna» oppure, in duetto, «Anna & Marco». */
export function singersOf(e: Pick<Entry, "singer" | "partner"> | null | undefined): string {
  if (!e?.singer) return "";
  return e.partner ? `${e.singer} & ${e.partner}` : e.singer;
}

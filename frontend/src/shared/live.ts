import { useEffect, useRef, useState } from "react";
import { api, PlayerState, PlaylistState, Song } from "./api";
import { setAvatars } from "./Avatar";
import { setMode } from "./mode";
import { setSettings } from "./settings";
import { publishMics } from "./mics";
import { setCompetition } from "./competition";
import { publishVoice } from "./voice";

type Listener = (event: string, data: any) => void;

// Chi usa questo telefono (nome e cognome): lo si comunica al PC a ogni connessione. Il PC risponde
// con il nome con cui è chiamato nella festa (evento "people"): il nome, oppure «Marco R.» se c'è un omonimo.
let presence: { first: string; last: string } = { first: "", last: "" };
let socket: WebSocket | null = null;
const sendPresence = () => {
  // senza nome (uscito dal profilo): il PC lo toglie dagli utenti collegati
  if (socket?.readyState === 1) socket.send(JSON.stringify({ hello: presence.first ? presence : "" }));
};
export function setPresence(first: string, last: string) {
  presence = { first, last };
  sendPresence();
}

/**
 * Stato condiviso in tempo reale (libreria + playlist) via WebSocket,
 * con riconnessione automatica e risincronizzazione completa a ogni connessione.
 */
export function useLive(onEvent?: Listener) {
  const [songs, setSongs] = useState<Song[]>([]);
  const [playlist, setPlaylist] = useState<PlaylistState>({ now_playing: null, entries: [], waiting: [] });
  const [connected, setConnected] = useState(false);
  const [synced, setSynced] = useState(false); // true dopo aver ricevuto la prima playlist dal server
  // stato del player + istante locale di ricezione, per stimare la posizione tra un aggiornamento e l'altro
  const [player, setPlayer] = useState<{ state: PlayerState; at: number } | null>(null);
  const listener = useRef(onEvent);
  listener.current = onEvent;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: number | undefined;
    let ping: number | undefined;
    let stale: number | undefined;
    let opening: number | undefined;
    let lastMessage = 0;

    // PC non raggiungibile (app chiusa, PC spento, fuori dal Wi-Fi): niente più brano in corso a
    // schermo, né nel Live né nel testo. Una breve pausa evita sfarfallii se la rete torna subito;
    // alla riconnessione lo stato vero arriva di nuovo dal PC.
    const dropLive = () => {
      setPlayer(null);
      setPlaylist((p) => (p.now_playing ? { ...p, now_playing: null } : p));
    };

    const refresh = () => {
      api.songs().then(setSongs).catch(() => {});
      api.playlist().then(setPlaylist).catch(() => {});
    };

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      socket = ws;
      // Con l'app del PC chiusa il firewall di Windows spesso non rifiuta il tentativo ma lo ignora:
      // il telefono resterebbe minuti ad aspettare (anche dopo che l'app è stata riaperta). Se il PC
      // non risponde in pochi secondi si abbandona il tentativo e se ne fa un altro.
      window.clearTimeout(opening);
      const attempt = ws;
      opening = window.setTimeout(() => {
        if (ws === attempt && attempt.readyState === WebSocket.CONNECTING) lost();
      }, 4000);
      ws.onopen = () => {
        window.clearTimeout(opening);
        window.clearTimeout(stale);
        stale = undefined;
        setConnected(true);
        sendPresence(); // solo se si sa già chi usa il telefono
        refresh();
        lastMessage = performance.now();
        // il PC risponde a ogni ping: se tace troppo a lungo (spento di colpo, Wi-Fi perso) la
        // connessione è morta anche se il browser non se n'è accorto, e la si chiude
        window.clearInterval(ping);
        ping = window.setInterval(() => {
          if (ws?.readyState !== 1) return;
          if (performance.now() - lastMessage > 12000) lost();
          else ws.send("ping");
        }, 4000);
      };
      ws.onmessage = (msg) => {
        lastMessage = performance.now();
        const { event, data } = JSON.parse(msg.data);
        if (event === "song") {
          setSongs((prev) => {
            const i = prev.findIndex((s) => s.id === data.id);
            if (i < 0) return [data, ...prev];
            const next = prev.slice();
            next[i] = data;
            return next;
          });
        } else if (event === "song_removed") {
          setSongs((prev) => prev.filter((s) => s.id !== data.id));
        } else if (event === "playlist") {
          setPlaylist(data);
          setSynced(true);
        } else if (event === "settings") {
          setSettings(data);
        } else if (event === "mode") {
          setMode(data);
        } else if (event === "avatars") {
          setAvatars(data);
        } else if (event === "voice") {
          publishVoice(data);
        } else if (event === "competition") {
          setCompetition(data);
        } else if (event === "mics") {
          publishMics(data?.mics ?? []);
        } else if (event === "player_state") {
          setPlayer(data ? { state: data, at: performance.now() } : null);
        }
        listener.current?.(event, data);
      };
      ws.onclose = lost;
    };
    // connessione persa (chiusa dal PC, o morta senza avviso): si riprova a collegarsi
    const lost = () => {
      window.clearTimeout(opening);
      window.clearTimeout(retry); // un solo nuovo tentativo alla volta
      if (ws) {
        ws.onclose = ws.onmessage = null; // una connessione morta può avvisare della chiusura molto dopo
        ws.close();
      }
      setConnected(false);
      window.clearInterval(ping);
      // la pausa parte alla prima perdita: i tentativi falliti che seguono non la rinviano
      if (stale === undefined)
        stale = window.setTimeout(() => {
          stale = undefined;
          dropLive();
        }, 3000);
      if (!closed) retry = window.setTimeout(connect, 1500);
    };
    connect();
    // schermo riacceso (il telefono in standby aveva chiuso la connessione) o rete tornata: ci si
    // ricollega subito, senza aspettare il prossimo tentativo
    const wake = () => {
      if (closed || document.visibilityState !== "visible") return;
      if (ws?.readyState === WebSocket.OPEN) {
        if (performance.now() - lastMessage > 6000) ws.send("ping"); // ancora viva? se no, lost() col ping
        return;
      }
      if (ws?.readyState !== WebSocket.CONNECTING) {
        window.clearTimeout(retry);
        connect();
      }
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    window.addEventListener("pageshow", wake);
    return () => {
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener("pageshow", wake);
      closed = true;
      window.clearTimeout(retry);
      window.clearTimeout(stale);
      window.clearTimeout(opening);
      window.clearInterval(ping);
      ws?.close();
    };
  }, []);

  return { songs, playlist, connected, setPlaylist, player, synced };
}

export type LivePlayer = ReturnType<typeof useLive>["player"];

/** Posizione attuale stimata del brano sulla TV (secondi). */
export function playerTime(p: LivePlayer): number {
  if (!p) return 0;
  const { t, playing, duration } = p.state;
  const now = playing ? t + (performance.now() - p.at) / 1000 : t;
  return Math.min(now, duration || now);
}

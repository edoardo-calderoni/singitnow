import { useEffect, useRef, useState } from "react";
import { api, PlayerState, PlaylistState, Song } from "./api";
import { setAvatars } from "./Avatar";

type Listener = (event: string, data: any) => void;

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

    const refresh = () => {
      api.songs().then(setSongs).catch(() => {});
      api.playlist().then(setPlaylist).catch(() => {});
    };

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => {
        setConnected(true);
        refresh();
        ping = window.setInterval(() => ws?.readyState === 1 && ws.send("ping"), 20000);
      };
      ws.onmessage = (msg) => {
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
        } else if (event === "avatars") {
          setAvatars(data);
        } else if (event === "player_state") {
          setPlayer(data ? { state: data, at: performance.now() } : null);
        }
        listener.current?.(event, data);
      };
      ws.onclose = () => {
        setConnected(false);
        window.clearInterval(ping);
        if (!closed) retry = window.setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      closed = true;
      window.clearTimeout(retry);
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

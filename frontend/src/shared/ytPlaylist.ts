import { useEffect, useState } from "react";
import { api, SearchResult } from "./api";

/** Playlist di YouTube letta dal PC. */
export interface YtPlaylist {
  id: string;
  title: string;
  entries: (SearchResult & { in_library?: string | null })[];
}

/** ID della playlist se il testo è un link di YouTube con ?list=… (non i «Mix» RD…), altrimenti null. */
export function playlistId(text: string): string | null {
  if (!/youtu\.?be/i.test(text)) return null;
  const m = /[?&]list=([A-Za-z0-9_-]{10,})/.exec(text.trim());
  return m && !m[1].startsWith("RD") ? m[1] : null;
}

/** Link con solo la playlist (non un video dentro la playlist): si apre subito l'elenco. */
export const onlyPlaylist = (text: string) => !!playlistId(text) && !/[?&]v=|youtu\.be\/[A-Za-z0-9_-]{11}/.test(text);

/**
 * Elenco dei brani di una playlist da importare: si scelgono quelli da importare (di partenza
 * tutti quelli non ancora in libreria) e se metterli anche nella playlist della serata.
 */
export function usePlaylistImport(url: string) {
  const [pl, setPl] = useState<YtPlaylist | null>(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [queue, setQueue] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPl(null);
    setError("");
    api
      .youtubePlaylist(url)
      .then((p) => {
        setPl(p);
        setPicked(new Set(p.entries.filter((e) => !e.in_library).map((e) => e.youtube_id)));
      })
      .catch((e) => setError(e.message));
  }, [url]);

  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const all = (on: boolean) => setPicked(new Set(on ? (pl?.entries ?? []).map((e) => e.youtube_id) : []));

  /** Importa i brani scelti; restituisce quanti. */
  const run = async (singer = ""): Promise<number> => {
    if (!pl) return 0;
    setBusy(true);
    try {
      const items = pl.entries.filter((e) => picked.has(e.youtube_id));
      const r = await api.importYoutubePlaylist(items, queue, singer);
      return r.added;
    } finally {
      setBusy(false);
    }
  };

  return { pl, error, picked, toggle, all, queue, setQueue, busy, run };
}

import { useRef, useState } from "react";
import { api, SearchResult, youtubeId } from "./api";

export const SEARCH_PAGE = 12; // risultati per volta
const SEARCH_MAX = 60; // come sul server

/**
 * Ricerca su YouTube del pannello «Aggiungi brano», con «Carica altri risultati»:
 * si ripete la ricerca chiedendo più risultati e si aggiungono in fondo solo quelli nuovi,
 * così quelli già visti restano al loro posto.
 */
export function useYoutubeSearch(onError: (msg: string) => void) {
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [canMore, setCanMore] = useState(false);
  const query = useRef("");
  const limit = useRef(SEARCH_PAGE);
  const seq = useRef(0); // una nuova ricerca annulla il «carica altri» ancora in corso

  const run = async (text: string) => {
    if (!text.trim()) return;
    const my = ++seq.current;
    query.current = text;
    limit.current = SEARCH_PAGE;
    setBusy(true);
    setCanMore(false);
    try {
      const res = await api.search(text, SEARCH_PAGE);
      if (my !== seq.current) return;
      setResults(res);
      // un link porta a un solo video: niente altri risultati
      setCanMore(!youtubeId(text) && res.length > 0);
    } catch (e: any) {
      if (my === seq.current) onError(e.message);
    } finally {
      if (my === seq.current) setBusy(false);
    }
  };

  const loadMore = async () => {
    if (loadingMore || !results) return;
    const my = seq.current;
    const next = Math.min(limit.current + SEARCH_PAGE, SEARCH_MAX);
    setLoadingMore(true);
    try {
      const res = await api.search(query.current, next);
      if (my !== seq.current) return;
      limit.current = next;
      const seen = new Set(results.map((r) => r.youtube_id));
      const fresh = res.filter((r) => !seen.has(r.youtube_id));
      setResults([...results, ...fresh]);
      setCanMore(fresh.length > 0 && next < SEARCH_MAX);
    } catch (e: any) {
      if (my === seq.current) onError(e.message);
    } finally {
      if (my === seq.current) setLoadingMore(false);
    }
  };

  return { results, busy, loadingMore, canMore, run, loadMore };
}

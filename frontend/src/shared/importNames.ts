import { useEffect, useState } from "react";
import { api, SearchResult } from "./api";

const ARM_MS = 800;

/**
 * Artista e titolo da confermare prima di importare un video: partono da quelli ricavati dai dati di
 * YouTube e chi importa li può correggere. Sono quelli con cui si cerca il testo, quindi contano.
 */
export function useImportNames(r: SearchResult) {
  const [artist, setArtist] = useState("");
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(true);
  // il pulsante di conferma si attiva solo dopo un attimo: un doppio tocco su «Aggiungi» non deve
  // confermare per sbaglio il pannello appena aperto
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setArmed(true), ARM_MS);
    return () => window.clearTimeout(id);
  }, []);
  useEffect(() => {
    let alive = true;
    api
      .importGuess(r.title, r.channel)
      .then((g) => {
        if (!alive) return;
        setArtist(g.artist);
        setTitle(g.title);
      })
      .catch(() => {
        if (!alive) return;
        setArtist(r.channel);
        setTitle(r.title);
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [r.title, r.channel]);
  const ready = armed && !loading && artist.trim().length > 0 && title.trim().length > 0;
  return { artist, setArtist, title, setTitle, loading, ready };
}

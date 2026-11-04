export type SongStatus = "queued" | "downloading" | "separating" | "lyrics" | "ready" | "error";

export interface Song {
  id: string;
  youtube_id: string;
  title: string;
  artist: string;
  duration: number;
  thumbnail_url: string;
  status: SongStatus;
  progress: number;
  step: string;
  error: string;
  lyrics_source: string;
  language: string;
  created_at: number;
  media?: { video: string; instrumental: string; vocals: string; lyrics: string };
}

export interface SearchResult {
  youtube_id: string;
  title: string;
  channel: string;
  duration: number;
  thumbnail: string;
  in_library: SongStatus | null;
}

export interface Entry {
  id: string;
  song_id: string;
  singer: string;
  added_at: number;
  song: Song | null;
}

export interface PlaylistState {
  now_playing: Entry | null;
  entries: Entry[];
  waiting: { song_id: string; singer: string; song: Song | null }[];
}

export interface LyricWord {
  t: string;
  s: number;
  e: number;
}
export interface LyricLine {
  start: number;
  end: number;
  text: string;
  words: LyricWord[];
}
export interface Lyrics {
  source: string;
  language: string;
  lines: LyricLine[];
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = (await res.json()).detail ?? msg;
    } catch {
      /* risposta non JSON */
    }
    throw new Error(msg);
  }
  return res.json();
}

export const api = {
  info: () => req<{ version: string; remote_url: string; qr_svg: string }>("GET", "/api/info"),
  songs: () => req<Song[]>("GET", "/api/songs"),
  lyrics: (id: string) => req<Lyrics>("GET", `/api/songs/${id}/lyrics`),
  deleteSong: (id: string) => req("DELETE", `/api/songs/${id}`),
  retry: (id: string) => req("POST", `/api/songs/${id}/retry`),
  patchSong: (id: string, data: Partial<Pick<Song, "artist" | "title" | "language">>) =>
    req<Song>("PATCH", `/api/songs/${id}`, data),
  resync: (id: string, artist: string, title: string) =>
    req("POST", `/api/songs/${id}/lyrics/resync`, { artist, title }),
  search: (q: string) => req<SearchResult[]>("GET", `/api/search?q=${encodeURIComponent(q)}`),
  download: (r: SearchResult, singer = "") =>
    req<Song>("POST", "/api/download", {
      youtube_id: r.youtube_id,
      title: r.title,
      channel: r.channel,
      duration: r.duration,
      singer,
    }),
  playlist: () => req<PlaylistState>("GET", "/api/playlist"),
  enqueue: (song_id: string, singer: string) => req<PlaylistState>("POST", "/api/playlist", { song_id, singer }),
  unqueue: (entry_id: string) => req<PlaylistState>("DELETE", `/api/playlist/${entry_id}`),
  move: (entry_id: string, delta: number) => req<PlaylistState>("POST", `/api/playlist/${entry_id}/move`, { delta }),
  playEntry: (entry_id?: string) => req<PlaylistState>("POST", "/api/player/play", { entry_id }),
  playSong: (song_id: string, singer = "") => req<PlaylistState>("POST", "/api/player/play", { song_id, singer }),
  stop: () => req<PlaylistState>("POST", "/api/player/stop"),
  command: (action: string, value?: number) => req("POST", "/api/player/command", { action, value }),
};

export function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export const LANGUAGES: Record<string, string> = { it: "Italiano", en: "Inglese" };

export function languageLabel(code: string): string {
  return LANGUAGES[code] ?? (code ? code.toUpperCase() : "—");
}

export function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]!.toUpperCase())
      .join("") || "?"
  );
}

/** Filtro libreria: testo libero su titolo/artista + lingua. */
export function filterSongs(songs: Song[], text: string, lang: string): Song[] {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "");
  const terms = norm(text).split(/\s+/).filter(Boolean);
  return songs.filter((s) => {
    if (lang && s.language !== lang) return false;
    const hay = norm(`${s.title} ${s.artist}`);
    return terms.every((t) => hay.includes(t));
  });
}

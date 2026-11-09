export type SongStatus = "queued" | "downloading" | "separating" | "lyrics" | "ready" | "error";

export interface Song {
  id: string;
  youtube_id: string;
  title: string;
  artist: string;
  duration: number;
  /** immagine del brano: copertina del disco se trovata, altrimenti fotogramma di YouTube */
  thumbnail_url: string;
  /** copertina del disco (iTunes), se trovata */
  cover_url?: string | null;
  /** fotogramma del video YouTube */
  video_thumbnail_url?: string;
  status: SongStatus;
  progress: number;
  step: string;
  /** secondi stimati alla fine dell'elaborazione (0 = sconosciuto) */
  eta: number;
  /** in attesa di essere preparato: posizione nella coda di importazione (1 = il prossimo) */
  queue_pos?: number;
  error: string;
  lyrics_source: string;
  language: string;
  created_at: number;
  /** ultima riproduzione (secondi; 0 = mai) */
  played_at?: number;
  media?: { video: string; instrumental: string; vocals: string; lyrics: string; pitch?: string; beats?: string };
}

export interface SearchResult {
  youtube_id: string;
  title: string;
  channel: string;
  duration: number;
  thumbnail: string;
  url: string; // pagina del video su YouTube
  in_library: SongStatus | null;
}

export interface Entry {
  id: string;
  song_id: string;
  singer: string;
  added_at: number;
  /** avviata automaticamente perché la playlist era ferma */
  auto?: boolean;
  /** duetto: chi canta insieme a `singer` (ha accettato la proposta) */
  partner?: string;
  song: Song | null;
}

export interface PlaylistState {
  now_playing: Entry | null;
  entries: Entry[];
  /** prenotati ancora in preparazione, in ordine di richiesta */
  waiting: { song_id: string; singer: string; song: Song | null; requested_at?: number }[];
  /** modalità DJ: brani chiesti dagli utenti, in attesa che il DJ li accetti */
  requests?: DjRequest[];
  /** proposte di duetto in attesa di risposta */
  duets?: DuetProposal[];
}

export interface DuetProposal {
  id: string;
  entry_id: string;
  from: string;
  to: string;
  song: Song | null;
}

export interface DjRequest {
  id: string;
  song_id: string;
  singer: string;
  song: Song | null;
}

/** Posizione del player sulla TV, comunicata ogni secondo. */
export interface PlayerState {
  song_id: string;
  t: number;
  duration: number;
  playing: boolean;
  offset: number;
  vocals: number;
  volume?: number; // volume generale (0..1)
  key?: number; // tonalità della base in semitoni rispetto all'originale
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
  /** riga originale quando `text` è una trascrizione (giapponese → romaji) */
  orig?: string;
  words: LyricWord[];
}
export interface Lyrics {
  source: string;
  language: string;
  lines: LyricLine[];
}

/** Competizione: classifica della sessione con la media dei voti di ciascuno. */
export interface Standing {
  singer: string;
  average: number;
  songs: {
    song_id: string;
    title: string;
    score: number; // punteggio del brano (intonazione + pubblico)
    pitch?: number; // voto d'intonazione
    audience?: number | null; // media delle stelle del pubblico
    votes?: number;
  }[];
}
/** Persona entrata nella festa: nome, cognome e il nome con cui è chiamata (con l'iniziale se ha un omonimo). */
export interface Person {
  first: string;
  last: string;
  name: string;
}
/** Un posto nella hall of fame di un brano (miglior punteggio di sempre di quel cantante). */
export interface HallEntry {
  singer: string;
  avatar?: string; // nome con cui è salvata la sua foto (quello che aveva alla festa)
  score: number;
  t: number; // quando (secondi dal 1970)
}
/** Voto salvato: quello che serve al pannello di fine brano. */
export interface ScoreSaved {
  ranking: ScoreEntry[];
  position: number | null;
  competition_position: number | null; // posto nella competizione (null se il voto non conta)
  competition: boolean; // competizione accesa
  standings: Standing[];
  hall_of_fame: HallEntry[];
  t: number;
}
export interface Competition {
  enabled: boolean;
  active: boolean; // sessione in corso
  standings: Standing[];
  /** votazione del pubblico aperta sull'esibizione appena finita */
  vote?: AudienceVoteState | null;
  /** peso del voto del pubblico nel punteggio del brano (0..1) */
  audience_weight?: number;
}

/** Spazio su disco: occupazione dei brani (byte) e totali. */
export interface StorageReport {
  songs: {
    id: string;
    title: string;
    artist: string;
    status: string;
    played_at: number;
    never_played: boolean;
    sizes: { video: number; audio: number; keys: number; other: number };
    total: number;
  }[];
  library: number;
  keys: number;
  recordings: number;
  models: number;
  work: number;
  free: number;
  disk: number;
}

/** Registrazione di un'esibizione (la vede solo chi ha cantato). */
export interface Recording {
  id: string;
  t: number;
  song_id: string;
  title: string;
  artist: string;
  seconds: number;
  names: string[];
  ready: boolean; // convertita in M4A
}

/** Indirizzo per scaricare una registrazione. */
export const recordingUrl = (id: string, first: string, last: string) =>
  `/api/recordings/${id}/file?first=${encodeURIComponent(first)}&last=${encodeURIComponent(last)}`;

/** Profilo di una persona, da tutte le serate (nome e cognome scritti sul telefono). */
export interface Profile {
  performances: number;
  first_seen: number | null;
  best: { score: number; title: string; song_id: string; t: number } | null;
  favorite: { title: string; count: number } | null;
  recent: { title: string; artist: string; song_id: string; t: number; score: number | null; partner: string }[];
}

export interface AudienceVoteState {
  entry_id: string;
  singers: string[];
  song_id: string;
  title: string;
  until: number; // secondi (epoch) a cui si chiude
  votes: number;
}

/** Voce dei microfoni gestita da SingITnow (motore audio a bassa latenza) e autotune. */
export interface VoiceState {
  engine: boolean; // true = la voce passa da SingITnow, false = da Windows («Ascolta questo dispositivo»)
  autotune: boolean;
  strength: number; // 0..1
  boost: number; // amplificazione della voce dei microfoni (fissa al massimo: 4 = +12 dB)
  running: boolean;
  latency_ms: number;
  mics: number;
  error: string;
  listening: string[]; // microfoni con «Ascolta questo dispositivo» ancora attivo (voce doppia)
  correction_cents: number; // di quanto l'autotune sta correggendo la voce (media dell'ultimo secondo)
  singing: boolean; // il motore sente qualcuno cantare
}

/** Microfono per cantare (volume e muto di Windows). */
export interface Mic {
  index: number;
  name: string;
  volume: number;
  muted: boolean;
}

/** Rete Wi-Fi di casa per gli ospiti (la vedono solo gli amministratori). */
export interface Wifi {
  ssid: string;
  password: string;
  security: "WPA" | "WEP" | "nopass";
  hidden: boolean;
}

/** Il gettone da amministratore (se c'è) accompagna ogni richiesta: abilita i comandi del player. */
function authHeaders(body: unknown): Record<string, string> {
  const h: Record<string, string> = body ? { "Content-Type": "application/json" } : {};
  try {
    const t = localStorage.getItem("sin.adminToken");
    if (t) h["X-Admin-Token"] = t;
  } catch {
    /* storage non disponibile */
  }
  return h;
}

export const PC_UNREACHABLE = "Connessione persa: controlla che SingITnow sia aperto sul PC e riprova";

/**
 * fetch verso il PC con un tempo massimo: se l'app sul PC è chiusa, Windows spesso non risponde
 * affatto e la richiesta resterebbe appesa per minuti (pulsanti bloccati). Errori in italiano.
 */
export async function fetchPC(url: string, init: RequestInit = {}, timeoutMs = 60000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch {
    throw new Error(PC_UNREACHABLE); // tempo scaduto o PC non raggiungibile
  } finally {
    window.clearTimeout(timer);
  }
}

async function req<T>(method: string, url: string, body?: unknown, timeoutMs?: number): Promise<T> {
  const res = await fetchPC(
    url,
    {
      method,
      headers: authHeaders(body),
      body: body ? JSON.stringify(body) : undefined,
    },
    timeoutMs,
  );
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
  pitch: (id: string) => req<{ notes: ([number, number, number] | [number, number, number, number])[] }>("GET", `/api/songs/${id}/pitch`),
  scores: () => req<{ ranking: ScoreEntry[] }>("GET", "/api/scores"),
  people: () => req<{ people: Person[] }>("GET", "/api/people"),
  addScore: (song_id: string, singer: string, score: number, label = "", entry_id = "") =>
    req<ScoreSaved>("POST", "/api/scores", { song_id, singer, score, label, entry_id }),
  deleteSong: (id: string) => req("DELETE", `/api/songs/${id}`),
  storage: () => req<StorageReport>("GET", "/api/admin/storage"),
  clearKeys: (song_id?: string) => req("POST", "/api/admin/storage/keys", { song_id: song_id ?? null }),
  clearWork: () => req("POST", "/api/admin/storage/work"),
  retry: (id: string) => req("POST", `/api/songs/${id}/retry`),
  patchSong: (id: string, data: Partial<Pick<Song, "artist" | "title" | "language">>) =>
    req<Song>("PATCH", `/api/songs/${id}`, data),
  setLyrics: (id: string, text: string) => req("PUT", `/api/songs/${id}/lyrics`, { text }),
  resync: (id: string, artist: string, title: string) =>
    req("POST", `/api/songs/${id}/lyrics/resync`, { artist, title }),
  search: (q: string, limit = 12) =>
    req<SearchResult[]>("GET", `/api/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  /** Importa un video. artist/name: artista e titolo confermati da chi importa (i refusi li corregge il PC). */
  youtubePlaylist: (url: string) =>
    req<import("./ytPlaylist").YtPlaylist>("GET", `/api/youtube-playlist?url=${encodeURIComponent(url)}`, undefined, 90000),
  importYoutubePlaylist: (items: SearchResult[], queue: boolean, singer = "") =>
    req<{ added: number }>("POST", "/api/youtube-playlist/import", {
      items: items.map((r) => ({ youtube_id: r.youtube_id, title: r.title, channel: r.channel, duration: r.duration })),
      queue,
      singer,
    }),
  download: (r: SearchResult, singer = "", artist = "", name = "") =>
    req<Song>("POST", "/api/download", {
      youtube_id: r.youtube_id,
      title: r.title,
      channel: r.channel,
      duration: r.duration,
      singer,
      artist,
      name,
    }),
  /** Artista e titolo proposti dai dati del video, da confermare prima dell'importazione. */
  importGuess: (title: string, channel: string) =>
    req<{ artist: string; title: string }>(
      "GET",
      `/api/import/guess?title=${encodeURIComponent(title)}&channel=${encodeURIComponent(channel)}`,
    ),
  playlist: () => req<PlaylistState>("GET", "/api/playlist"),
  users: () => req<{ users: string[] }>("GET", "/api/users"),
  enqueue: (song_id: string, singer: string) => req<PlaylistState>("POST", "/api/playlist", { song_id, singer }),
  unqueue: (entry_id: string, singer = "") =>
    req<PlaylistState>("DELETE", `/api/playlist/${entry_id}?singer=${encodeURIComponent(singer)}`),
  unqueueWaiting: (song_id: string, singer: string) =>
    req<PlaylistState>("DELETE", `/api/playlist/waiting/${song_id}?singer=${encodeURIComponent(singer)}`),
  approveRequest: (id: string, singer: string) =>
    req<PlaylistState>("POST", `/api/playlist/requests/${id}/approve`, { singer }),
  rejectRequest: (id: string, singer: string) =>
    req<PlaylistState>("DELETE", `/api/playlist/requests/${id}?singer=${encodeURIComponent(singer)}`),
  move: (entry_id: string, delta: number, singer = "") =>
    req<PlaylistState>("POST", `/api/playlist/${entry_id}/move`, { delta, singer }),
  proposeDuet: (entry_id: string, singer: string, partner: string) =>
    req<PlaylistState>("POST", `/api/playlist/${entry_id}/duet`, { singer, partner }),
  answerDuet: (id: string, singer: string, accept: boolean) =>
    req<PlaylistState>("POST", `/api/duets/${id}/answer`, { singer, accept }),
  cancelDuet: (id: string, singer: string) =>
    req<PlaylistState>("DELETE", `/api/duets/${id}?singer=${encodeURIComponent(singer)}`),
  leaveDuet: (entry_id: string, singer: string) =>
    req<PlaylistState>("DELETE", `/api/playlist/${entry_id}/duet?singer=${encodeURIComponent(singer)}`),
  playEntry: (entry_id?: string) => req<PlaylistState>("POST", "/api/player/play", { entry_id }),
  playSong: (song_id: string, singer = "") => req<PlaylistState>("POST", "/api/player/play", { song_id, singer }),
  stop: () => req<PlaylistState>("POST", "/api/player/stop"),
  next: () => req<PlaylistState>("POST", "/api/player/next"),
  showQr: () => req("POST", "/api/admin/qr"),
  competition: () => req<Competition>("GET", "/api/competition"),
  stats: () => req<import("./stats").EveningStats>("GET", "/api/stats"),
  uploadRecording: async (blob: Blob, song_id: string, seconds: number, singer: string, partner: string) => {
    const q = new URLSearchParams({ song_id, seconds: String(Math.round(seconds)), singer, partner });
    const res = await fetchPC(`/api/recordings?${q}`, { method: "POST", headers: authHeaders(undefined), body: blob }, 120000);
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.detail ?? "Registrazione non salvata");
  },
  recordings: (first: string, last: string) =>
    req<{ recordings: Recording[]; keep_days: number }>(
      "GET",
      `/api/recordings?first=${encodeURIComponent(first)}&last=${encodeURIComponent(last)}`,
    ),
  deleteRecording: (id: string, first: string, last: string) =>
    req("DELETE", `/api/recordings/${id}?first=${encodeURIComponent(first)}&last=${encodeURIComponent(last)}`),
  profile: (first: string, last: string) =>
    req<Profile>("GET", `/api/profile?first=${encodeURIComponent(first)}&last=${encodeURIComponent(last)}`),
  statsQr: () => req<{ url: string; qr_svg: string }>("GET", "/api/stats/qr"),
  showStats: () => req("POST", "/api/admin/stats/show"),
  vote: (entry_id: string, voter: string, stars: number) =>
    req<Competition>("POST", "/api/vote", { entry_id, voter, stars }),
  setCompetition: (enabled: boolean, name = "") => req<Competition>("POST", "/api/admin/competition", { enabled, name }),
  showRanking: () => req("POST", "/api/admin/competition/show"),
  fullscreen: () => req("POST", "/api/admin/fullscreen"),
  mics: () => req<{ mics: Mic[] }>("GET", "/api/mics"),
  voice: () => req<VoiceState>("GET", "/api/voice"),
  setVoice: (change: Partial<Pick<VoiceState, "engine" | "autotune" | "strength">>) =>
    req<VoiceState>("POST", "/api/voice", change),
  setMic: (index: number, change: { volume?: number; muted?: boolean }) =>
    req<{ mics: Mic[] }>("POST", `/api/mics/${index}`, change),
  wifi: () => req<{ wifi: Wifi | null }>("GET", "/api/admin/wifi"),
  detectWifi: () => req<{ wifi: Wifi }>("GET", "/api/admin/wifi/detect"),
  saveWifi: (w: Wifi) => req<{ wifi: Wifi | null }>("PUT", "/api/admin/wifi", w),
  showWifi: () => req("POST", "/api/admin/wifi/show"),
  wifiQr: () => req<{ ssid: string; security: Wifi["security"]; qr_svg: string }>("GET", "/api/wifi/qr"),
  settings: () => req<{ autoplay: boolean; locked: boolean; record: boolean }>("GET", "/api/settings"),
  changeAdminPassword: (old: string, next: string) => req<{ ok: boolean }>("POST", "/api/admin/password", { old, new: next }),
  setSettings: (change: { autoplay?: boolean; locked?: boolean; record?: boolean }) =>
    req<{ autoplay: boolean; locked: boolean; record: boolean }>("POST", "/api/admin/settings", change),
  setMode: (mode: "karaoke" | "jukebox" | "dj") => req<{ mode: string; dj: string }>("POST", "/api/admin/mode", { mode }),
  setDj: (name: string) => req<{ mode: string; dj: string }>("POST", "/api/admin/dj", { name }),
  command: (action: string, value?: number, singer = "") => req("POST", "/api/player/command", { action, value, singer }),
  playerState: (state: PlayerState) => req("POST", "/api/player/state", state),
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

/** Tempo residuo di elaborazione in forma leggibile ("≈ 2 min"), "" se sconosciuto. Per i brani
 *  ancora in coda è il tempo fino a quando saranno pronti (compresi quelli davanti). */
export function fmtEta(song?: Pick<Song, "eta" | "status"> | null): string {
  if (!song || !song.eta || song.status === "ready" || song.status === "error") return "";
  const s = song.eta;
  if (s < 15) return "quasi pronto";
  if (s < 60) return `≈ ${Math.ceil(s / 10) * 10} s`;
  return `≈ ${Math.ceil(s / 60)} min`;
}

/** Stato di un brano in preparazione: «In coda (2°)» se aspetta il suo turno, altrimenti la percentuale. */
export function fmtPrep(song?: Pick<Song, "status" | "progress" | "queue_pos"> | null): string {
  if (!song) return "";
  if (song.status === "queued") return song.queue_pos ? `In coda (${song.queue_pos}°)` : "In coda";
  return `${Math.round((song.progress ?? 0) * 100)}%`;
}

/** Voto d'intonazione di fine brano (e riga della classifica della serata). */
export interface ScoreEntry {
  singer: string;
  score: number;
  song_id: string;
  title: string;
  t: number;
  position?: number | null;
  /** con due microfoni: «Microfono Blu» o il nome di chi ha prenotato */
  label?: string;
}

/** ID del video se il testo è un link di YouTube (si importa direttamente quel video), altrimenti null. */
export function youtubeId(text: string): string | null {
  const m = /(?:youtube(?:-nocookie)?\.com\/(?:.*[?&]v=|shorts\/|embed\/|live\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/i.exec(text.trim());
  return m ? m[1] : null;
}

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Clock, ListMusic, Maximize, Play, Smartphone, Trash2, Wifi, WifiOff } from "lucide-react";
import { api, Entry, fmtTime, Song, Standing } from "../shared/api";
import { entryStarts, fmtWait, useTick } from "../shared/queue";
import { useLive } from "../shared/live";
import { Avatar } from "../shared/Avatar";
import { EditDialog, SingerDialog } from "./Dialogs";
import { TimingEditor } from "./TimingEditor";
import { enterFullscreen, exitFullscreen, Player, toggleFullscreen } from "./Player";
import { RequestEvent, RequestToasts, useRequests } from "./Requests";
import { HandoverBanner, useHandover } from "./Handover";
import { ApplauseLayer, useApplause } from "./Applause";
import { ReactionLayer, useReactions } from "./Reactions";
import { useJukebox } from "../shared/mode";
import { DjPicker, ModeSeg } from "./ModeSeg";
import { ResultsHost, useResultsOpen, winnerJustCelebrated } from "./ResultsPanel";
import { BackgroundMusic } from "./BackgroundMusic";
import { Splash, useSplash } from "../shared/Splash";
import { CompetitionSwitch, RankingCorner, RankingDialog, WinnerScreen } from "./Competition";
import { Participants } from "./Participants";
import { EveningStatsPanel, StatsButton } from "./EveningStats";
import { EveningButton, EveningNotice } from "./Evening";
import { useEvening } from "../shared/evening";
import { SettingsButton } from "./Settings";
import { QuizOverlay } from "./Quiz";
import { useQuiz } from "../shared/quiz";
import { useSettings } from "../shared/settings";
import { LibraryView, SearchView } from "./Views";
import { RejectedDialog } from "./Rejected";
import type { ImportRejected } from "../shared/api";

type Tab = "library" | "search";

const WINNER_SECONDS = 20; // a fine serata il vincitore resta tanto, poi arrivano le statistiche

export function App() {
  const requests = useRequests();
  const applause = useApplause();
  const reactions = useReactions();
  const { songs, playlist, connected, player } = useLive((event, data) => {
    if (event === "player_command") window.dispatchEvent(new CustomEvent("player-command", { detail: data }));
    // brani aggiunti dal PC stesso: l'avviso va solo sui telefoni
    else if (event === "request") !data?.from_pc && requests.push(data as RequestEvent);
    else if (event === "import_rejected") setRejected(data as ImportRejected);
    else if (event === "applause") applause.push(data.name);
    else if (event === "reaction") reactions.push(data.name, data.emoji);
    else if (event === "show_qr") showQr(data?.seconds ?? 10);
    else if (event === "show_wifi") showWifi(data?.seconds ?? 10);
    else if (event === "show_ranking") showRanking(data?.seconds ?? 10);
    else if (event === "show_stats") setStatsOpen(true);
    else if (event === "backup") window.dispatchEvent(new CustomEvent("sin-backup", { detail: data }));
    else if (event === "fullscreen") enterFullscreen();
    else if (event === "users") setUsers(Array.isArray(data) ? data : []);
    else if (event === "user_joined" && data?.name) requests.pushJoin(data.name);
    else if (event === "duet" && data?.kind === "accepted") requests.pushDuet(data.from, data.to, data.song ?? null);
    // il vincitore appena festeggiato nel pannello di fine serata non si mostra due volte
    else if (event === "competition_end" && !winnerJustCelebrated()) setWinner(data?.standings ?? null);
    // serata conclusa: dopo il vincitore (o subito) le statistiche della serata
    else if (event === "evening_end" && data?.stats) setFinale(true);
  });
  const [tab, setTab] = useState<Tab>("library");
  const [info, setInfo] = useState<{ remote_url: string; qr_svg: string } | null>(null);
  const [toast, setToast] = useState("");
  const [rejected, setRejected] = useState<ImportRejected | null>(null);
  const [searchFor, setSearchFor] = useState({ q: "", k: 0 });
  const [queueFor, setQueueFor] = useState<Song | null>(null);
  const [editing, setEditing] = useState<Song | null>(null);
  const [timingFor, setTimingFor] = useState<Song | null>(null);
  // QR code d'ingresso mostrato per qualche secondo nell'angolo (richiesto da un amministratore)
  const jukebox = useJukebox();
  const [qrShown, setQrShown] = useState(false);
  const qrTimer = useRef<number | undefined>(undefined);
  function showQr(seconds: number) {
    setQrShown(false); // riavvia l'animazione se arriva una nuova richiesta
    setWifiQr(null); // un QR alla volta nello stesso angolo
    setRankingShown(null);
    window.clearTimeout(qrTimer.current);
    requestAnimationFrame(() => setQrShown(true));
    qrTimer.current = window.setTimeout(() => setQrShown(false), seconds * 1000);
  }
  // QR code del Wi-Fi di casa: l'evento non porta la password, il QR si chiede al server
  const [wifiQr, setWifiQr] = useState<{ ssid: string; qr_svg: string; seconds: number } | null>(null);
  const wifiTimer = useRef<number | undefined>(undefined);
  function showWifi(seconds: number) {
    api
      .wifiQr()
      .then((w) => {
        setWifiQr(null); // riavvia l'animazione se arriva una nuova richiesta
        setQrShown(false); // un QR alla volta nello stesso angolo
        setRankingShown(null);
        window.clearTimeout(wifiTimer.current);
        requestAnimationFrame(() => setWifiQr({ ssid: w.ssid, qr_svg: w.qr_svg, seconds }));
        wifiTimer.current = window.setTimeout(() => setWifiQr(null), seconds * 1000);
      })
      .catch(() => {});
  }

  // Competizione: classifica in tempo reale nello stesso angolo dei QR (stessa durata), schermata
  // del vincitore a fine sessione e classifica completa dal pulsante sotto l'interruttore
  const [rankingShown, setRankingShown] = useState<number | null>(null);
  const rankingTimer = useRef<number | undefined>(undefined);
  function showRanking(seconds: number) {
    setRankingShown(null);
    setQrShown(false);
    setWifiQr(null);
    window.clearTimeout(rankingTimer.current);
    requestAnimationFrame(() => setRankingShown(seconds));
    rankingTimer.current = window.setTimeout(() => setRankingShown(null), seconds * 1000);
  }
  const [winner, setWinner] = useState<Standing[] | null>(null);
  const [finale, setFinale] = useState(false); // serata appena conclusa: statistiche in arrivo
  const evening = useEvening();
  // partecipanti collegati dal telefono (pannello sotto il QR code): all'avvio e a ogni riconnessione
  // si chiede l'elenco, poi lo aggiorna l'evento "users"
  const [users, setUsers] = useState<string[]>([]);
  useEffect(() => {
    if (connected) api.users().then((r) => setUsers(r.users)).catch(() => {});
  }, [connected]);
  const [rankingOpen, setRankingOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false); // riepilogo della serata
  const closeStats = useCallback(() => setStatsOpen(false), []);

  useEffect(() => {
    api.info().then(setInfo).catch(() => {});
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 3500);
    return () => clearTimeout(t);
  }, [toast]);


  const safe = useCallback(async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e: any) {
      setToast(e.message);
    }
  }, []);

  const now = playlist.now_playing;
  const nowSong = now?.song?.status === "ready" ? now : null;
  // brano ridotto a finestrella in basso a destra (freccia in alto a sinistra nel player): anche i
  // brani successivi restano nella finestrella finché non la si rimette a tutto schermo. Quando la
  // musica si ferma del tutto (X, Stop, coda finita) il prossimo avvio torna a tutto schermo.
  const [mini, setMini] = useState(false);
  const playingNow = !!nowSong;
  const resultsOpen = useResultsOpen();
  const [splash, splashDone] = useSplash(); // video di avvio
  // «Anna passa il microfono a Marco!» al cambio di cantante (Karaoke)
  const handover = useHandover(nowSong, !jukebox);
  useEffect(() => {
    if (!playingNow) setMini(false);
    else {
      setWinner(null); // parte una nuova sessione: via la schermata del vincitore
      // la musica parte da ferma («Avvia playlist», «Avvia ora», dal telefono…): schermo intero.
      // Fra un brano e l'altro no: se durante la serata si esce con Esc, si resta in finestra.
      enterFullscreen();
    }
  }, [playingNow]);
  // Schermo intero in tutta l'app (si parte già a schermo intero): Esc esce, F o F11 lo rimettono.
  // Durante un brano Esc non chiude il brano: si chiude solo con Stop o con la X.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const el = ev.target as HTMLElement;
      const typing = el?.tagName === "TEXTAREA" || (el?.tagName === "INPUT" && (el as HTMLInputElement).type !== "range");
      if (ev.key === "Escape") exitFullscreen();
      else if (ev.key === "F11" || ((ev.key === "f" || ev.key === "F") && !typing && !ev.ctrlKey && !ev.altKey && !ev.metaKey)) {
        ev.preventDefault();
        toggleFullscreen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const nextEntry = playlist.entries[0];

  // ------------------------------------------------------------ quiz musicale fra un brano e l'altro
  const quizOn = useSettings()?.quiz ?? false;
  const quiz = useQuiz();
  const quizAfter = useRef<string | null>(null); // brano finito prima del quiz in corso
  const nowIdRef = useRef<string | undefined>(undefined);
  nowIdRef.current = now?.id;
  const goNext = () => safe(() => api.playEntry().catch(() => api.stop()));
  /** Brano finito (dopo il voto): prima il quiz, se è acceso e si può fare, poi il successivo. */
  const afterSong = (entryId: string) => {
    if (!quizOn || jukebox || !nextEntry) return goNext();
    api
      .quizStart(entryId, nextEntry.id)
      .then((r) => {
        if (r.started) quizAfter.current = entryId;
        else goNext();
      })
      .catch(goNext);
  };
  // quiz finito: parte il brano successivo (se nel frattempo nessuno ha cambiato o fermato la musica)
  useEffect(() => {
    if (quiz || !quizAfter.current) return;
    const after = quizAfter.current;
    quizAfter.current = null;
    if (nowIdRef.current === after) goNext();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quiz]);
  // primo brano prenotato ancora in preparazione (con lo stato aggiornato dalla libreria): se la coda
  // finisce prima che sia pronto, la TV lo aspetta con un conto alla rovescia
  const firstWaiting = playlist.waiting[0];
  const waitingNext = firstWaiting
    ? { singer: firstWaiting.singer, song: songs.find((s) => s.id === firstWaiting.song_id) ?? firstWaiting.song }
    : undefined;
  // modalità DJ, mix in battuta: brano successivo caricato in anticipo (fermo), brano che sfuma
  // mentre parte il successivo, e quello entrato col mix (il suo video compare in dissolvenza)
  const [cued, setCued] = useState<Entry | null>(null);
  const [outgoing, setOutgoing] = useState<Entry | null>(null);
  const [mixInId, setMixInId] = useState<string | null>(null);
  useEffect(() => {
    if (!nowSong) {
      // Stop: si ferma tutto
      setOutgoing(null);
      setCued(null);
    } else if (cued && nowSong.id === cued.id) {
      setCued(null); // il brano in attesa è diventato quello in corso (stesso player)
    } else if (cued && !outgoing && nextEntry?.id !== cued.id) {
      setCued(null); // prima del mix il DJ ha cambiato il prossimo brano: si scarta
    }
  }, [nowSong, nextEntry, cued, outgoing]);
  useTick(1000); // aggiorna i tempi di attesa della playlist
  const starts = entryStarts(playlist, player);
  // brani in playlist (solo quelli pronti) e durata complessiva
  const queued = playlist.entries;
  const totalDuration = queued.reduce((t, e) => t + (e.song?.duration ?? 0), 0);

  // fine serata: chiuso il vincitore (e il pannello dei voti) si aprono le statistiche
  useEffect(() => {
    if (finale && !winner && !resultsOpen && !nowSong) {
      setFinale(false);
      setStatsOpen(true);
    }
  }, [finale, winner, resultsOpen, nowSong]);
  return (
    <div className="app">
      {/* ------------------------------------------------ sidebar */}
      <nav className="sidebar">
        <div className="brand">
          <img src="/icon.svg" alt="" />
          <span>
            Sing<span className="grad-text">IT</span>now
          </span>
          <SettingsButton onError={setToast} />
          <button className="icon-btn fullscreen-btn" title="Schermo intero (F)" onClick={toggleFullscreen}>
            <Maximize size={20} />
          </button>
        </div>
        <div className="mode-switch">
          <div className="mode-switch-label">Modalità</div>
          <ModeSeg onError={setToast} />
          <DjPicker users={users} onError={setToast} />
          <CompetitionSwitch onShowRanking={() => setRankingOpen(true)} />
          {!jukebox && <StatsButton onClick={() => setStatsOpen(true)} />}
          <EveningButton playlist={playlist} songs={songs} onError={setToast} />
        </div>

        {/* QR code piccolo per entrare e, sotto, chi è collegato dal telefono in questo momento;
            lo spazio libero va in fondo, sopra lo stato della connessione */}
        <Participants users={users} qrSvg={info?.qr_svg} />

        <div className="sidebar-spacer" />
        <div className={`conn ${connected ? "on" : ""}`}>
          {connected ? <Wifi size={14} /> : <WifiOff size={14} />} {connected ? "Connesso" : "Riconnessione…"}
        </div>
      </nav>

      {/* ------------------------------------------------ contenuto */}
      <main className="content">
        {tab === "library" ? (
          <LibraryView
            songs={songs}
            waiting={playlist.waiting}
            onCancelWaiting={(songId, singer) => safe(() => api.unqueueWaiting(songId, singer))}
            onPlay={(s) => safe(() => api.playSong(s.id))}
            onQueue={(s) => (jukebox ? safe(() => api.enqueue(s.id, "")) : setQueueFor(s))}
            onEdit={setEditing}
            onToast={setToast}
            goSearch={() => setTab("search")}
          />
        ) : (
          <SearchView
            key={searchFor.k}
            songs={songs}
            onToast={setToast}
            onBack={() => setTab("library")}
            initialQuery={searchFor.q}
          />
        )}
      </main>

      {/* ------------------------------------------------ playlist */}
      <aside className="queue">
        <div className="queue-head">
          <h2>
            <ListMusic size={22} /> Playlist
          </h2>
          {queued.length > 0 && (
            <span className="muted queue-summary">
              {queued.length} {queued.length === 1 ? "brano" : "brani"} in playlist | Durata: {fmtTotal(totalDuration)}
            </span>
          )}
        </div>

        {nextEntry && (
          <button className="btn btn-primary btn-block" onClick={() => safe(() => api.playEntry())}>
            <Play size={18} fill="currentColor" />
            Avvia playlist
          </button>
        )}

        <ol className="queue-list">
          {playlist.entries.map((e: Entry, i) => (
            <li key={e.id} className="queue-item">
              <div className="queue-pos">{i + 1}</div>
              {/* copertina del disco come sfondo della card, scurita per leggere bene il testo */}
              {e.song?.thumbnail_url && <img className="queue-bg" src={e.song.thumbnail_url} alt="" />}
              {/* tutto per intero (titolo e artista vanno a capo); chi l'ha richiesto per ultimo */}
              <div className="queue-main">
                <div className="queue-song">{e.song?.title}</div>
                {e.song?.artist && <div className="queue-artist">{e.song.artist}</div>}
                <div className="queue-meta">
                  <span>
                    <Clock size={13} /> {fmtTime(e.song?.duration ?? 0)}
                  </span>
                  <span className="queue-wait">{i === 0 && !now ? "è il prossimo" : `fra ${fmtWait(starts[i]!)}`}</span>
                </div>
                {e.singer && (
                  <div className="queue-singer">
                    <Avatar name={e.singer} className="xs" />
                    <span>{e.singer}</span>
                    {e.partner && !jukebox && (
                      <>
                        <span className="queue-amp">&</span>
                        <Avatar name={e.partner} className="xs" />
                        <span>{e.partner}</span>
                        <span className="queue-duet">Duetto</span>
                      </>
                    )}
                  </div>
                )}
              </div>
              <div className="queue-actions">
                <button className="icon-btn" title="Su" disabled={i === 0} onClick={() => safe(() => api.move(e.id, -1))}>
                  <ChevronUp size={16} />
                </button>
                <button className="icon-btn" title="Avvia ora" onClick={() => safe(() => api.playEntry(e.id))}>
                  <Play size={16} />
                </button>
                <button className="icon-btn danger" title="Rimuovi" onClick={() => safe(() => api.unqueue(e.id))}>
                  <Trash2 size={16} />
                </button>
                <button
                  className="icon-btn"
                  title="Giù"
                  disabled={i === playlist.entries.length - 1}
                  onClick={() => safe(() => api.move(e.id, 1))}
                >
                  <ChevronDown size={16} />
                </button>
              </div>
            </li>
          ))}
          {/* i brani ancora in preparazione non si vedono: entrano in playlist quando sono pronti */}
        </ol>
        {playlist.entries.length === 0 && (
          <div className="queue-empty">
            <img src="/empty-playlist.png" alt="" />
            <p>La playlist è vuota, apri l'app e clicca su "LIBRERIA" per aggiungere un brano.</p>
          </div>
        )}
      </aside>

      {/* in un array con le chiavi: durante il mix il brano in uscita resta lo stesso player
          (non riparte) mentre accanto si monta quello nuovo */}
      {[
        outgoing && nowSong && outgoing.id !== nowSong.id ? outgoing : null,
        nowSong,
        cued && nowSong && cued.id !== nowSong.id && cued.id !== outgoing?.id ? cued : null,
      ].map((e) =>
        !e ? null : e.id === outgoing?.id ? (
          <Player
            key={e.id}
            entry={e}
            next={undefined}
            outgoing
            onGone={() => setOutgoing(null)}
            onClose={() => setOutgoing(null)}
            onNext={() => setOutgoing(null)}
            mini={mini}
          />
        ) : e.id === cued?.id && e.id !== nowSong?.id ? (
          // caricato e fermo, nascosto: lo fa partire il brano in corso sul battito giusto
          <Player key={e.id} entry={e} next={undefined} cued onClose={() => {}} onNext={() => {}} mini={mini} />
        ) : (
          <Player
            key={e.id}
            entry={e}
            // ultimo brano della serata: dopo non c'è niente (niente mix né quiz), a fine brano si
            // ferma e il PC conclude la serata
            next={evening.closing && evening.lastEntry === e.id ? undefined : nextEntry}
            waitingNext={evening.closing && evening.lastEntry === e.id ? undefined : waitingNext}
            mixIn={e.id === mixInId}
            onClose={() => safe(() => api.stop())}
            onNext={() => afterSong(e.id)}
            onPrepareMix={() => nextEntry && setCued(nextEntry)}
            onMixStart={() => {
              // il successivo si sente: il server lo mette in riproduzione, questo sfuma
              const n = cued ?? nextEntry;
              setOutgoing(e);
              setMixInId(n?.id ?? null);
              safe(() => (n ? api.playEntry(n.id) : api.playEntry()).catch(() => api.stop()));
            }}
            mini={mini}
            onMinimize={() => setMini(true)}
            onExpand={() => setMini(false)}
          />
        ),
      )}

      {queueFor && (
        <SingerDialog
          song={queueFor}
          onCancel={() => setQueueFor(null)}
          onConfirm={(singer) => {
            const s = queueFor;
            setQueueFor(null);
            safe(() => api.enqueue(s.id, singer));
          }}
        />
      )}
      {editing && (
        <EditDialog
          song={editing}
          onClose={() => setEditing(null)}
          onToast={setToast}
          onEditTimings={() => (setTimingFor(editing), setEditing(null))}
        />
      )}
      {timingFor && <TimingEditor song={timingFor} onClose={() => setTimingFor(null)} onToast={setToast} />}
      {rejected && !nowSong && (
        // l'app sul PC è anche lo schermo della TV: l'avviso aspetta che non suoni niente
        <RejectedDialog
          data={rejected}
          onClose={() => setRejected(null)}
          onSearch={(q) => {
            setRejected(null);
            setSearchFor((p) => ({ q, k: p.k + 1 }));
            setTab("search");
          }}
        />
      )}
      {/* nel pannello principale in basso a destra; con un brano in corso (anche nella finestrella,
          che occupa l'angolo in basso) in alto a destra */}
      <RequestToasts items={requests.items} bottom={!nowSong} />
      <HandoverBanner pass={handover} />
      <ResultsHost />
      <QuizOverlay />
      {/* sottofondo della schermata principale: sfuma quando parte la playlist */}
      <BackgroundMusic active={!splash && !now && !resultsOpen && !winner && !timingFor} />
      {splash && <Splash onDone={splashDone} />}
      {rankingShown !== null && <RankingCorner seconds={rankingShown} onClose={() => setRankingShown(null)} />}
      {winner && !nowSong && (
        <WinnerScreen standings={winner} autoClose={finale ? WINNER_SECONDS : 0} onClose={() => setWinner(null)} />
      )}
      <EveningNotice playlist={playlist} songs={songs} />
      {rankingOpen && <RankingDialog onClose={() => setRankingOpen(false)} />}
      {statsOpen && <EveningStatsPanel onClose={closeStats} />}
      {qrShown && info && (
        // stessa card (e misura) del QR del Wi-Fi
        <div className="wifi-corner qr-corner" title="Clic per chiudere" onClick={() => setQrShown(false)}>
          <div className="wifi-corner-head">
            <Smartphone size={18} /> App
          </div>
          <div className="wifi-corner-code" dangerouslySetInnerHTML={{ __html: info.qr_svg }} />
          <div className="wifi-corner-ssid">Entra anche tu!</div>
          <div className="wifi-corner-hint">Inquadra con la fotocamera per partecipare</div>
        </div>
      )}
      {wifiQr && (
        <div
          className="wifi-corner"
          title="Clic per chiudere"
          style={{ "--wifi-seconds": `${wifiQr.seconds}s` } as React.CSSProperties}
          onClick={() => setWifiQr(null)}
        >
          <div className="wifi-corner-head">
            <Wifi size={18} /> Wi-Fi
          </div>
          <div className="wifi-corner-code" dangerouslySetInnerHTML={{ __html: wifiQr.qr_svg }} />
          <div className="wifi-corner-ssid">{wifiQr.ssid}</div>
          <div className="wifi-corner-hint">Inquadra con la fotocamera per collegarti</div>
        </div>
      )}
      {nowSong && !jukebox && <ApplauseLayer bubbles={applause.bubbles} />}
      {nowSong && !jukebox && <ReactionLayer items={reactions.items} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

/** Durata totale della playlist: m:ss, oppure h:mm:ss da un'ora in su. */
function fmtTotal(sec: number): string {
  const t = Math.max(0, Math.round(sec));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = (t % 60).toString().padStart(2, "0");
  return h ? `${h}:${m.toString().padStart(2, "0")}:${s}` : `${m}:${s}`;
}

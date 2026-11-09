import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Loader2, Music, Users, X } from "lucide-react";
import { api, DuetProposal, Entry, PlaylistState, Song } from "../shared/api";
import { Avatar } from "../shared/Avatar";
import { LivePlayer } from "../shared/live";
import { entryStarts, fmtWait } from "../shared/queue";
import { vibrate } from "./Live";

type Safe = (fn: () => Promise<unknown>, ok?: string) => Promise<void>;

const same = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

// ------------------------------------------------------------------ invito ricevuto
/**
 * Proposta di duetto ricevuta: a tutto schermo, con vibrazione, finché non si risponde.
 * Le proposte arrivano con la playlist, quindi ricompaiono anche dopo una riconnessione; se il brano
 * esce dalla coda (o chi l'ha proposta la ritira) la proposta sparisce da sola.
 */
export function DuetInvite({
  name,
  playlist,
  player,
  safe,
}: {
  name: string;
  playlist: PlaylistState;
  player: LivePlayer;
  safe: Safe;
}) {
  const invite = (playlist.duets ?? []).find((d) => same(d.to, name));
  const [busy, setBusy] = useState(false);
  const buzzed = useRef<string | null>(null);
  useEffect(() => {
    if (invite && buzzed.current !== invite.id) {
      buzzed.current = invite.id;
      vibrate([300, 120, 300, 120, 600]);
    }
  }, [invite?.id]);
  useEffect(() => setBusy(false), [invite?.id]);
  if (!invite) return null;
  const idx = playlist.entries.findIndex((e) => e.id === invite.entry_id);
  const starts = entryStarts(playlist, player);
  const when =
    idx < 0 ? "" : idx === 0 && !playlist.now_playing ? "È il prossimo brano" : `Tocca fra ${fmtWait(starts[idx] ?? 0)}`;
  const answer = (accept: boolean) => {
    setBusy(true);
    safe(
      () => api.answerDuet(invite.id, name, accept),
      accept ? `🎤 Canterai in duetto con ${invite.from}!` : "Proposta rifiutata",
    ).finally(() => setBusy(false));
  };
  return createPortal(
    <div className="m-sheet m-duet-back">
      <div className="m-sheet-card m-duet-invite" role="alertdialog" aria-labelledby="m-duet-title">
        <div className="m-duet-faces">
          <Avatar name={invite.from} className="big" />
          <span className="m-duet-mic">🎤</span>
          <Avatar name={name} className="big" />
        </div>
        <div className="m-sheet-title" id="m-duet-title">
          <b>{invite.from}</b> ti propone un duetto!
        </div>
        <SongLine song={invite.song} />
        {when && <div className="m-duet-when">{when}</div>}
        <div className="m-sheet-actions">
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => answer(false)}>
            <X size={17} /> Rifiuta
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => answer(true)}>
            {busy ? <Loader2 size={17} className="spin" /> : <Check size={17} />} Accetta
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function SongLine({ song }: { song: Song | null }) {
  return (
    <div className="m-duet-song">
      <div className="m-duet-cover cover">{song?.thumbnail_url ? <img src={song.thumbnail_url} alt="" /> : <Music size={22} />}</div>
      <div className="ellipsis">
        <div className="m-item-title ellipsis">{song?.title ?? "Brano"}</div>
        {song?.artist && <div className="m-item-sub ellipsis">{song.artist}</div>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ scelta del partner
/** Elenco degli utenti collegati (tranne sé stessi) tra cui scegliere con chi cantare. */
function DuetPicker({ entry, name, onClose, safe }: { entry: Entry; name: string; onClose: () => void; safe: Safe }) {
  const [users, setUsers] = useState<string[] | null>(null);
  const [sending, setSending] = useState("");
  useEffect(() => {
    api
      .users()
      .then((r) => setUsers(r.users.filter((u) => !same(u, name))))
      .catch(() => setUsers([]));
  }, [name]);
  const pick = (u: string) => {
    setSending(u);
    safe(() => api.proposeDuet(entry.id, name, u).then(onClose), `Proposta inviata a ${u}`).finally(() => setSending(""));
  };
  return createPortal(
    <div className="m-sheet" onClick={onClose}>
      <div className="m-sheet-card m-duet-pick" onClick={(e) => e.stopPropagation()}>
        <div className="m-sheet-title">Con chi vuoi cantare?</div>
        <SongLine song={entry.song} />
        {users === null ? (
          <div className="m-mode-hint">Cerco chi è collegato…</div>
        ) : users.length === 0 ? (
          <div className="m-mode-hint">Nessun altro è collegato in questo momento.</div>
        ) : (
          <ul className="m-duet-users">
            {users.map((u) => (
              <li key={u}>
                <button type="button" disabled={!!sending} onClick={() => pick(u)}>
                  <Avatar name={u} className="xs" />
                  <span className="ellipsis">{u}</span>
                  {sending === u && <Loader2 size={16} className="spin" />}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="m-sheet-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Annulla
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------------ riga nella card del brano
/**
 * Sotto il nome di chi canta, nella card del brano in coda:
 * - chi l'ha prenotato: «Proponi duetto», poi «In attesa di …» (si può ritirare), poi «Duetto con …»;
 * - chi si è unito: «Duetto con …» e la possibilità di rinunciare.
 */
export function DuetControls({
  entry,
  name,
  proposal,
  canPropose,
  safe,
}: {
  entry: Entry;
  name: string;
  proposal: DuetProposal | undefined;
  /** c'è almeno un altro utente collegato: senza, il pulsante «Proponi duetto» non compare */
  canPropose: boolean;
  safe: Safe;
}) {
  const [picking, setPicking] = useState(false);
  const owner = same(entry.singer, name);
  const partner = !!entry.partner && same(entry.partner, name);
  if (!owner && !partner) return null;
  if (entry.partner) {
    const mate = owner ? entry.partner : entry.singer;
    return (
      <div className="m-duet-row on">
        <Users size={14} /> <span className="ellipsis">Duetto con <b>{mate}</b></span>
        <button
          type="button"
          className="m-duet-x"
          title={owner ? "Annulla il duetto" : "Rinuncia al duetto"}
          onClick={() => {
            if (!confirm(owner ? `Annullare il duetto con ${mate}?` : `Rinunciare al duetto con ${mate}?`)) return;
            safe(() => api.leaveDuet(entry.id, name), "Duetto annullato");
          }}
        >
          <X size={14} />
        </button>
      </div>
    );
  }
  if (proposal) {
    return (
      <div className="m-duet-row wait">
        <Loader2 size={14} className="spin" /> <span className="ellipsis">In attesa di <b>{proposal.to}</b>…</span>
        <button
          type="button"
          className="m-duet-x"
          title="Ritira la proposta"
          onClick={() => safe(() => api.cancelDuet(proposal.id, name), "Proposta ritirata")}
        >
          <X size={14} />
        </button>
      </div>
    );
  }
  if (!canPropose && !picking) return null;
  return (
    <>
      <button type="button" className="btn btn-ghost btn-sm m-duet-btn" onClick={() => setPicking(true)}>
        <Users size={15} /> Proponi duetto
      </button>
      {picking && <DuetPicker entry={entry} name={name} safe={safe} onClose={() => setPicking(false)} />}
    </>
  );
}

// ------------------------------------------------------------------ risposte
interface DuetEvent {
  kind: "accepted" | "declined" | "left";
  from: string;
  to: string;
  by?: string;
  song?: Song | null;
}

interface Notice {
  key: number;
  text: React.ReactNode;
  face: string;
  song: Song | null;
  leaving: boolean;
}

const SHOW_MS = 6000;
const LEAVE_MS = 300;

/** Avviso a chi aspetta la risposta (accettata / rifiutata) e all'altro quando un duetto si annulla. */
export function useDuetNotice(myName: string) {
  const [notice, setNotice] = useState<Notice | null>(null);
  const nameRef = useRef(myName);
  nameRef.current = myName;
  const seq = useRef(0);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const push = useCallback((d: DuetEvent) => {
    const me = nameRef.current;
    if (!d?.from || !d?.to || !me) return;
    let text: React.ReactNode = null;
    let face = "";
    if (d.kind === "accepted" && same(d.from, me)) {
      text = (
        <>
          <b>{d.to}</b> ha accettato il duetto! Canterete insieme 🎤
        </>
      );
      face = d.to;
    } else if (d.kind === "declined" && same(d.from, me)) {
      text = (
        <>
          <b>{d.to}</b> ha rifiutato il duetto.
        </>
      );
      face = d.to;
    } else if (d.kind === "left" && d.by) {
      // l'avviso va all'altro dei due
      const other = same(d.by, d.from) ? d.to : same(d.by, d.to) ? d.from : "";
      if (other && same(other, me)) {
        text = (
          <>
            <b>{d.by}</b> ha annullato il duetto.
          </>
        );
        face = d.by;
      }
    }
    if (!text) return;
    vibrate(d.kind === "accepted" ? [200, 100, 200] : [200]);
    timers.current.forEach(clearTimeout);
    const key = ++seq.current;
    setNotice({ key, text, face, song: d.song ?? null, leaving: false });
    timers.current = [
      window.setTimeout(() => setNotice((n) => (n?.key === key ? { ...n, leaving: true } : n)), SHOW_MS),
      window.setTimeout(() => setNotice((n) => (n?.key === key ? null : n)), SHOW_MS + LEAVE_MS),
    ];
  }, []);
  return { notice, push };
}

/** Stesso aspetto dell'avviso «Nuovo brano aggiunto»: in alto, lascia passare i tocchi. */
export function DuetNotice({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  return (
    <div key={notice.key} className={`m-added ${notice.leaving ? "leaving" : ""}`} role="status" aria-live="polite">
      <div className="m-added-row">
        <div className="m-added-cover cover">
          {notice.song?.thumbnail_url ? <img src={notice.song.thumbnail_url} alt="" /> : <Avatar name={notice.face} />}
        </div>
        <div className="m-added-body">
          {notice.song && <div className="m-added-title">{notice.song.title}</div>}
          <div className="m-added-msg">{notice.text}</div>
        </div>
      </div>
    </div>
  );
}

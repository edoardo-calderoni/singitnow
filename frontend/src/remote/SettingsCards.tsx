import { useState } from "react";
import { Maximize } from "lucide-react";
import { api } from "../shared/api";
import { PasswordInput } from "../shared/PasswordInput";
import { useSettings } from "../shared/settings";

/**
 * Settaggi della serata per gli amministratori (gli stessi del pannello «Settaggi» del PC):
 * «Riproduzione automatica» e «Blocca inserimenti e richieste».
 */
export function PlaylistSettingsCard() {
  const settings = useSettings(); // aggiornati in tempo reale anche se li cambia il PC
  const [error, setError] = useState("");
  const set = (change: { autoplay?: boolean; locked?: boolean; auto_key?: boolean }) =>
    api
      .setSettings(change)
      .then(() => setError(""))
      .catch((e) => setError(e.message));
  return (
    <div className="m-mode m-settings">
      <div className="m-mode-label">Playlist</div>
      <SwitchRow
        label="Riproduzione automatica"
        desc="La playlist parte automaticamente quando un utente aggiunge un brano."
        value={settings?.autoplay ?? null}
        onChange={(v) => set({ autoplay: v })}
      />
      <SwitchRow
        label="Blocca inserimenti e richieste"
        desc="Nessuno può aggiungere o chiedere brani, neanche il DJ: solo gli amministratori e il PC gestiscono la playlist."
        value={settings?.locked ?? null}
        onChange={(v) => set({ locked: v })}
      />
      <SwitchRow
        label="Adatta la tonalità automaticamente"
        desc="In Karaoke ogni brano parte nella tonalità più comoda per chi lo canta, se SingITnow conosce già la sua voce."
        value={settings?.auto_key ?? null}
        onChange={(v) => set({ auto_key: v })}
      />
      {error && <div className="m-admin-err">{error}</div>}
    </div>
  );
}

/** Schermo del PC: un amministratore lo rimette a schermo intero (se qualcuno ha premuto Esc). */
export function ScreenCard() {
  const [msg, setMsg] = useState("");
  return (
    <div className="m-mode m-settings">
      <div className="m-mode-label">Schermo del PC</div>
      <button
        type="button"
        className="btn btn-primary btn-sm m-wifi-show"
        onClick={() =>
          api
            .fullscreen()
            .then(() => setMsg("App del PC a schermo intero"))
            .catch((e) => setMsg(e.message))
            .finally(() => window.setTimeout(() => setMsg(""), 2500))
        }
      >
        <Maximize size={15} /> Rimetti a schermo intero
      </button>
      <div className="m-mode-hint">Se l'app sul PC è uscita dallo schermo intero, la riporta a tutto schermo.</div>
      {msg && <div className="m-admin-msg">{msg}</div>}
    </div>
  );
}

function SwitchRow({
  label,
  desc,
  value,
  onChange,
}: {
  label: string;
  desc: string;
  value: boolean | null; // null = non ancora ricevuto dal PC
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="m-setting">
      <label className="m-switch">
        <input type="checkbox" checked={!!value} disabled={value === null} onChange={(e) => onChange(e.target.checked)} />
        <span className="m-switch-track" aria-hidden>
          <span className="m-switch-thumb" />
        </span>
        <span className="m-switch-label">{label}</span>
      </label>
      <div className="m-mode-hint">{desc}</div>
    </div>
  );
}

/** Cambio della password da amministratore: quella attuale, poi la nuova due volte. */
export function AdminPasswordCard() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = !!current && !!next && !!confirm && !busy;
  const edit = (set: (v: string) => void) => (v: string) => (set(v), setError(""));

  const submit = async () => {
    if (!ready) return;
    if (next !== confirm) return setError("La nuova password e la conferma non coincidono");
    setBusy(true);
    setError("");
    try {
      // dopo il cambio tutti gli amministratori (anche questo telefono) rientrano con la nuova
      await api.changeAdminPassword(current, next);
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <div className="m-mode m-settings">
      <div className="m-mode-label">Password amministratore</div>
      <PasswordInput placeholder="Password attuale" value={current} onChange={edit(setCurrent)} onEnter={submit} />
      <PasswordInput
        placeholder="Nuova password"
        autoComplete="new-password"
        value={next}
        onChange={edit(setNext)}
        onEnter={submit}
      />
      <PasswordInput
        placeholder="Conferma la nuova password"
        autoComplete="new-password"
        value={confirm}
        onChange={edit(setConfirm)}
        onEnter={submit}
      />
      {error && <div className="m-admin-err">{error}</div>}
      <div className="m-mode-hint">Tutti gli amministratori, anche tu, dovranno rientrare con la nuova password.</div>
      <button type="button" className="btn btn-primary btn-block" disabled={!ready} onClick={submit}>
        {busy ? "Salvataggio…" : "Cambia password"}
      </button>
    </div>
  );
}

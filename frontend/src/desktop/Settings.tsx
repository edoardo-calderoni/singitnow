import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Settings as Gear, X } from "lucide-react";
import { api } from "../shared/api";
import { PasswordInput } from "../shared/PasswordInput";
import { StorageSetting } from "./Storage";
import { BackupSetting } from "./Backup";

/** Ingranaggio a destra del logo: apre il pannello «Settaggi». */
export function SettingsButton({ onError }: { onError: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="icon-btn settings-btn" title="Settaggi" onClick={() => setOpen(true)}>
        <Gear size={20} />
      </button>
      {open && createPortal(<SettingsDialog onClose={() => setOpen(false)} onError={onError} />, document.body)}
    </>
  );
}

type Key = "autoplay" | "locked" | "record" | "auto_key";

function SettingsDialog({ onClose, onError }: { onClose: () => void; onError: (m: string) => void }) {
  const [values, setValues] = useState<Record<Key, boolean> | null>(null);
  useEffect(() => {
    api
      .settings()
      .then(setValues)
      .catch((e) => onError(e.message));
  }, [onError]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggle = (key: Key, value: boolean) => {
    setValues((v) => (v ? { ...v, [key]: value } : v));
    api
      .setSettings({ [key]: value })
      .then(setValues)
      .catch((e) => {
        setValues((v) => (v ? { ...v, [key]: !value } : v));
        onError(e.message);
      });
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal modal-settings" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Settaggi</h3>
          <button type="button" className="icon-btn" title="Chiudi" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <SwitchSetting
          label="Riproduzione automatica"
          desc="La playlist parte automaticamente quando un utente aggiunge un brano."
          value={values?.autoplay ?? null}
          onChange={(v) => toggle("autoplay", v)}
        />
        <SwitchSetting
          label="Blocca inserimenti e richieste"
          desc="Nessuno può aggiungere o chiedere brani, neanche il DJ: solo gli amministratori e il PC gestiscono la playlist."
          value={values?.locked ?? null}
          onChange={(v) => toggle("locked", v)}
        />
        <SwitchSetting
          label="Registra le esibizioni"
          desc="Voce dei microfoni e base: chi canta la scarica dal suo telefono (Profilo). Sulla TV si vede «REC» mentre registra; si cancellano dopo 60 giorni."
          value={values?.record ?? null}
          onChange={(v) => toggle("record", v)}
        />
        <SwitchSetting
          label="Adatta la tonalità automaticamente"
          desc="In Karaoke ogni brano parte nella tonalità più comoda per chi lo canta, se SingITnow conosce già la sua voce (la impara mentre canta). Chi canta può tornare all'originale dal telefono."
          value={values?.auto_key ?? null}
          onChange={(v) => toggle("auto_key", v)}
        />
        <StorageSetting onError={onError} />
        <BackupSetting onError={onError} />
        <AdminPasswordSetting onToast={onError} />
      </div>
    </div>
  );
}

/** Voce dei settaggi con l'interruttore a destra e la descrizione sotto. */
function SwitchSetting({
  label,
  desc,
  value,
  onChange,
}: {
  label: string;
  desc: string;
  value: boolean | null; // null = non ancora letto dal PC
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="setting">
      <label className="comp-switch">
        <input type="checkbox" checked={!!value} disabled={value === null} onChange={(e) => onChange(e.target.checked)} />
        <span className="comp-label">{label}</span>
        <span className="comp-track" aria-hidden>
          <span className="comp-thumb" />
        </span>
      </label>
      <p className="setting-desc">{desc}</p>
    </div>
  );
}

/** Cambio della password da amministratore: quella attuale, poi la nuova due volte. */
function AdminPasswordSetting({ onToast }: { onToast: (m: string) => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = !!current && !!next && !!confirm && !busy;

  const submit = async () => {
    if (!ready) return;
    if (next !== confirm) return setError("La nuova password e la conferma non coincidono");
    setBusy(true);
    setError("");
    try {
      await api.changeAdminPassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      onToast("Password da amministratore cambiata");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const edit = (set: (v: string) => void) => (v: string) => (set(v), setError(""));

  return (
    <div className="setting setting-password">
      <div className="setting-title">Password amministratore</div>
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
      {error && <div className="setting-error">{error}</div>}
      <p className="setting-desc">Gli amministratori già collegati dovranno rientrare con la nuova password.</p>
      <button type="button" className="btn btn-primary" disabled={!ready} onClick={submit}>
        {busy ? "Salvataggio…" : "Cambia password"}
      </button>
    </div>
  );
}

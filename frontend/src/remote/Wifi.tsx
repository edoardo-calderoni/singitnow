import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Eye, EyeOff, Loader2, Lock, Monitor, Pencil, QrCode, Smartphone, Wifi as WifiIcon } from "lucide-react";
import { api, Wifi } from "../shared/api";

/** La rete salvata, condivisa fra la scheda e il pulsante dei comandi del brano. */
let cached: Wifi | null | undefined;
const listeners = new Set<(w: Wifi | null) => void>();
function publish(w: Wifi | null) {
  cached = w;
  listeners.forEach((l) => l(w));
}

export function useWifi(): Wifi | null | undefined {
  const [w, setW] = useState(cached);
  useEffect(() => {
    listeners.add(setW);
    if (cached === undefined) api.wifi().then((r) => publish(r.wifi)).catch(() => {});
    return () => void listeners.delete(setW);
  }, []);
  return w;
}

/**
 * Amministratori: rete Wi-Fi di casa per gli ospiti. Si imposta una volta (anche leggendola dal PC)
 * e poi si mostra il QR code sulla TV: inquadrandolo il telefono si collega senza digitare la password.
 */
export function WifiCard() {
  const wifi = useWifi();
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    if (!msg) return;
    const id = window.setTimeout(() => setMsg(""), 2500);
    return () => window.clearTimeout(id);
  }, [msg]);
  if (wifi === undefined) return null;
  return (
    <div className="m-mode m-wifi">
      <div className="m-mode-label">Wi-Fi per gli ospiti</div>
      <div className="m-wifi-row">
        <WifiIcon size={18} />
        <span className="m-wifi-ssid">{wifi ? wifi.ssid : "Rete non impostata"}</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>
          <Pencil size={14} /> {wifi ? "Modifica" : "Imposta"}
        </button>
      </div>
      {wifi && (
        <button
          type="button"
          className="btn btn-primary btn-sm m-wifi-show"
          onClick={() =>
            api
              .showWifi()
              .then(() => setMsg("QR code del Wi-Fi sulla TV per 10 secondi"))
              .catch((e) => setMsg(e.message))
          }
        >
          <Monitor size={15} /> Mostra il QR sulla TV
        </button>
      )}
      {msg && <div className="m-admin-msg">{msg}</div>}
      {/* nel body: dentro la card la finestra sarebbe posizionata rispetto alla card, non allo schermo */}
      {editing && createPortal(<WifiSheet initial={wifi} onClose={() => setEditing(false)} />, document.body)}
    </div>
  );
}

/** Amministratori: mostra per 10 secondi sulla TV il QR code per scaricare l'app ed entrare nella serata. */
export function AppQrCard() {
  const [msg, setMsg] = useState("");
  useEffect(() => {
    if (!msg) return;
    const id = window.setTimeout(() => setMsg(""), 2500);
    return () => window.clearTimeout(id);
  }, [msg]);
  return (
    <div className="m-mode m-wifi">
      <div className="m-mode-label">App per gli ospiti</div>
      <div className="m-wifi-row">
        <QrCode size={18} />
        <span className="m-wifi-ssid">QR code per scaricare l'app ed entrare</span>
      </div>
      <button
        type="button"
        className="btn btn-primary btn-sm m-wifi-show"
        onClick={() =>
          api
            .showQr()
            .then(() => setMsg("QR code dell'app sulla TV per 10 secondi"))
            .catch((e) => setMsg(e.message))
        }
      >
        <Monitor size={15} /> Mostra il QR sulla TV
      </button>
      {msg && <div className="m-admin-msg">{msg}</div>}
    </div>
  );
}

const SECURITY_LABELS: Record<Wifi["security"], string> = {
  WPA: "WPA / WPA2 / WPA3",
  WEP: "WEP",
  nopass: "Nessuna (rete aperta)",
};

export function WifiSheet({ initial, onClose }: { initial: Wifi | null; onClose: () => void }) {
  const [w, setW] = useState<Wifi>(initial ?? { ssid: "", password: "", security: "WPA", hidden: false });
  const [show, setShow] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"" | "detect" | "phone" | "save">("");
  const [qr, setQr] = useState<string | null>(null);
  const [hint, setHint] = useState("");
  const set = (p: Partial<Wifi>) => (setW((x) => ({ ...x, ...p })), setError(""), setHint(""), setQr(null));

  const detect = () => {
    setBusy("detect");
    api
      .detectWifi()
      .then((r) => {
        set(r.wifi);
        if (r.wifi.security !== "nopass" && !r.wifi.password)
          setError("Trovata la rete, ma Windows non ha fornito la password: scrivila a mano");
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(""));
  };

  // app Android (dalla versione 1.3): legge il nome della rete del telefono; la password va scritta a mano
  const phoneApp = (window as any).SingITnowApp;
  const canPhone = typeof phoneApp?.detectWifi === "function";
  const detectPhone = () => {
    setBusy("phone");
    const onResult = (ev: Event) => {
      window.removeEventListener("singitnow-wifi", onResult);
      window.clearTimeout(timer);
      setBusy("");
      const d = (ev as CustomEvent).detail ?? {};
      if (d.error) return setError(d.error);
      const sameNet = d.ssid === w.ssid;
      set({ ssid: d.ssid, security: d.security, hidden: !!d.hidden, password: sameNet ? w.password : "" });
      if (d.security !== "nopass" && !(sameNet && w.password)) {
        setHint("Rete trovata: ora scrivi la password del Wi-Fi");
        window.setTimeout(() => passwordEl?.focus(), 50);
      }
    };
    // se l'app non risponde (es. finestra del permesso chiusa senza scegliere) il pulsante torna attivo
    const timer = window.setTimeout(() => {
      window.removeEventListener("singitnow-wifi", onResult);
      setBusy("");
    }, 30000);
    window.addEventListener("singitnow-wifi", onResult);
    phoneApp.detectWifi();
  };
  const [passwordEl, setPasswordEl] = useState<HTMLInputElement | null>(null);

  return (
    <div className="m-sheet" onClick={onClose}>
      <form
        className="m-sheet-card"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          setBusy("save");
          api
            .saveWifi(w)
            .then((r) => {
              publish(r.wifi);
              if (!r.wifi) return onClose();
              // anteprima: il QR si può far inquadrare anche direttamente da questo telefono
              return api.wifiQr().then((q) => setQr(q.qr_svg));
            })
            .catch((err) => setError(err.message))
            .finally(() => setBusy(""));
        }}
      >
        <div className="m-sheet-title">Wi-Fi per gli ospiti</div>
        <p className="muted small m-wifi-note">
          Chi inquadra il QR code con la fotocamera si collega alla rete senza digitare la password.
          I dati restano sul PC e li vedono solo gli amministratori.
        </p>
        <div className="m-wifi-detect-label">Rileva la rete</div>
        <div className={`m-wifi-detect ${canPhone ? "two" : ""}`}>
          {canPhone && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={detectPhone} disabled={!!busy}>
              {busy === "phone" ? <Loader2 size={15} className="spin" /> : <Smartphone size={15} />} Dal telefono
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-sm" onClick={detect} disabled={!!busy}>
            {busy === "detect" ? <Loader2 size={15} className="spin" /> : <Monitor size={15} />} Dal PC
          </button>
        </div>
        <div className="field">
          <WifiIcon size={18} />
          <input
            placeholder="Nome della rete (SSID)"
            value={w.ssid}
            onChange={(e) => set({ ssid: e.target.value })}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
        <div className="field select">
          <select value={w.security} onChange={(e) => set({ security: e.target.value as Wifi["security"] })} aria-label="Sicurezza">
            {Object.entries(SECURITY_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </div>
        {w.security !== "nopass" && (
          <div className="field">
            <Lock size={18} />
            <input
              ref={setPasswordEl}
              type={show ? "text" : "password"}
              placeholder="Password del Wi-Fi"
              autoComplete="off"
              value={w.password}
              onChange={(e) => set({ password: e.target.value })}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <button type="button" className="icon-btn" onClick={() => setShow((s) => !s)} title={show ? "Nascondi" : "Mostra"}>
              {show ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
        )}
        <label className="m-wifi-hidden">
          <input type="checkbox" checked={w.hidden} onChange={(e) => set({ hidden: e.target.checked })} /> Rete nascosta
        </label>
        {error && <div className="m-admin-err">{error}</div>}
        {hint && !error && <div className="m-wifi-hint">{hint}</div>}
        {qr && (
          <div className="m-wifi-qr">
            <div dangerouslySetInnerHTML={{ __html: qr }} />
            <span>Salvata. Puoi farlo inquadrare anche da qui.</span>
          </div>
        )}
        <div className="m-sheet-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {qr ? "Chiudi" : "Annulla"}
          </button>
          {!qr && (
            <button className="btn btn-primary" disabled={!!busy}>
              {busy === "save" && <Loader2 size={16} className="spin" />} {w.ssid.trim() || !initial ? "Salva" : "Cancella rete"}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

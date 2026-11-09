import { Headphones, Mic2, Music } from "lucide-react";
import { api } from "../shared/api";
import { Mode, useDj, useMode } from "../shared/mode";

/** Scelta Karaoke / Jukebox / DJ dal PC (barra laterale e controlli del player). */
export function ModeSeg({ compact, onError }: { compact?: boolean; onError?: (msg: string) => void }) {
  const mode = useMode();
  const pick = (m: Mode) => {
    if (m !== mode) api.setMode(m).catch((e) => onError?.(e.message));
  };
  const size = compact ? 15 : 16;
  return (
    <div className={`mode-seg ${compact ? "compact" : ""}`} role="radiogroup" aria-label="Modalità della serata">
      <button role="radio" aria-checked={mode === "karaoke"} className={mode === "karaoke" ? "on" : ""} onClick={() => pick("karaoke")}>
        <Mic2 size={size} /> Karaoke
      </button>
      <button role="radio" aria-checked={mode === "jukebox"} className={mode === "jukebox" ? "on" : ""} onClick={() => pick("jukebox")}>
        <Music size={size} /> Jukebox
      </button>
      <button role="radio" aria-checked={mode === "dj"} className={mode === "dj" ? "on" : ""} onClick={() => pick("dj")}>
        <Headphones size={size} /> DJ
      </button>
    </div>
  );
}

/**
 * Modalità DJ: scelta del DJ della serata tra chi è collegato dal telefono. Solo lui (insieme agli
 * amministratori e al PC) può aggiungere brani alla playlist.
 */
export function DjPicker({ users, onError }: { users: string[]; onError?: (msg: string) => void }) {
  const mode = useMode();
  const dj = useDj();
  if (mode !== "dj") return null;
  // il DJ resta nell'elenco anche se in questo momento non è collegato
  const options = Array.from(new Set([dj, ...users].filter(Boolean)));
  return (
    <div className="dj-picker">
      <div className="mode-switch-label">DJ della serata</div>
      <div className="field">
        <Headphones size={16} />
        <select value={dj} onChange={(e) => api.setDj(e.target.value).catch((err) => onError?.(err.message))}>
          <option value="">{options.length ? "Solo gli Admin" : "Nessun partecipante collegato"}</option>
          {options.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

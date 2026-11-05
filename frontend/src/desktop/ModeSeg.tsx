import { Mic2, Music } from "lucide-react";
import { api } from "../shared/api";
import { Mode, useMode } from "../shared/mode";

/** Scelta Karaoke / Jukebox dal PC (barra laterale e controlli del player). */
export function ModeSeg({ compact, onError }: { compact?: boolean; onError?: (msg: string) => void }) {
  const mode = useMode();
  const pick = (m: Mode) => {
    if (m !== mode) api.setMode(m).catch((e) => onError?.(e.message));
  };
  return (
    <div className={`mode-seg ${compact ? "compact" : ""}`} role="radiogroup" aria-label="Modalità della serata">
      <button role="radio" aria-checked={mode === "karaoke"} className={mode === "karaoke" ? "on" : ""} onClick={() => pick("karaoke")}>
        <Mic2 size={compact ? 15 : 16} /> Karaoke
      </button>
      <button role="radio" aria-checked={mode === "jukebox"} className={mode === "jukebox" ? "on" : ""} onClick={() => pick("jukebox")}>
        <Music size={compact ? 15 : 16} /> Jukebox
      </button>
    </div>
  );
}

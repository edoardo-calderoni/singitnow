import { BarChart3, Download, Hand, Loader2, Mic2, Music, Users, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../shared/api";
import { Avatar, avatarUrlOf } from "../shared/Avatar";
import { EveningStats, StatsCard, statsCards, statsImage, statsTotals } from "../shared/stats";

const ICONS: Record<StatsCard["key"], typeof Hand> = { applause: Hand, pitch: Mic2, duet: Users, songs: Music };

function blobToBase64(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });
}

/** Arrivati dal QR code sulla TV (…/remote?stats=1): il riepilogo si apre subito. */
export const openedFromQr = () => new URLSearchParams(location.search).has("stats");

/** Pulsante nel Live che apre il riepilogo della serata. */
export function EveningStatsEntry() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn-ghost btn-block m-stats-btn" onClick={() => setOpen(true)}>
        <BarChart3 size={16} /> Statistiche della serata
      </button>
      {open && <EveningStatsSheet onClose={() => setOpen(false)} />}
    </>
  );
}

/** Riepilogo della serata sul telefono, da salvare (o condividere) come immagine. */
export function EveningStatsSheet({ onClose }: { onClose: () => void }) {
  const [stats, setStats] = useState<EveningStats | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState("");

  useEffect(() => {
    api.stats().then(setStats).catch((e) => setError(e.message));
  }, []);

  const save = async () => {
    if (!stats) return;
    setSaving(true);
    setError("");
    try {
      const blob = await statsImage(stats, avatarUrlOf);
      const fileName = `serata-${new Date(stats.started * 1000).toISOString().slice(0, 10)}.png`;
      const file = new File([blob], fileName, { type: "image/png" });
      // nell'app Android: la salva lei in Immagini/SingITnow
      const app = window.SingITnowApp;
      if (app?.saveFile) {
        const b64 = await blobToBase64(blob);
        setSaved(app.saveFile(b64, fileName, "image/png") ? "Salvata in Immagini/SingITnow" : "Salvataggio non riuscito");
        return;
      }
      // dal telefono: condividi (salva in galleria, WhatsApp…); altrimenti scarica il file
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: "La serata" }).catch(() => {});
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        a.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 5000);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const cards = stats ? statsCards(stats) : [];
  return (
    <div className="m-sheet" onClick={onClose}>
      <div className="m-sheet-card m-stats-card" role="dialog" aria-labelledby="m-stats-title" onClick={(e) => e.stopPropagation()}>
        <div className="m-stats-head">
          <div id="m-stats-title" className="m-sheet-title grad-text">
            La serata
          </div>
          <button type="button" className="icon-btn" title="Chiudi" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {!stats && !error && <Loader2 className="spin" />}
        {stats && <div className="m-stats-totals">{statsTotals(stats)}</div>}
        {stats && !cards.length && (
          <p className="m-mode-hint">Ancora nessuna esibizione: le statistiche arrivano con i primi brani cantati.</p>
        )}
        {cards.map((k) => {
          const Icon = ICONS[k.key];
          return (
            <div className="m-stats-row" key={k.key}>
              <div className="m-stats-people">
                {k.people.slice(0, 2).map((n) => (
                  <Avatar key={n} name={n} className="xs" />
                ))}
              </div>
              <div className="m-stats-text">
                <div className="m-stats-label">
                  <Icon size={13} /> {k.label}
                </div>
                <b className="ellipsis">{k.people.join(" e ")}</b>
                <div className="m-stats-sub ellipsis">
                  <span>{k.main}</span> {k.detail}
                </div>
              </div>
            </div>
          );
        })}
        {error && <div className="m-vote-note err">{error}</div>}
        {saved && <div className="m-vote-note">{saved}</div>}
        {cards.length > 0 && (
          <button type="button" className="btn btn-primary btn-wide" onClick={save} disabled={saving}>
            {saving ? <Loader2 size={16} className="spin" /> : <Download size={16} />} Salva come immagine
          </button>
        )}
      </div>
    </div>
  );
}

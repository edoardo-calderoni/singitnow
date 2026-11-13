import { BarChart3, Hand, Mic2, Music, Users, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../shared/api";
import { Avatar } from "../shared/Avatar";
import { EveningStats, StatsCard, statsCards, statsTotals } from "../shared/stats";

const ICONS: Record<StatsCard["key"], typeof Hand> = { applause: Hand, pitch: Mic2, duet: Users, songs: Music };

/** Pulsante nella barra laterale: apre il riepilogo della serata sulla TV. */
export function StatsButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="btn btn-ghost btn-sm stats-btn" onClick={onClick}>
      <BarChart3 size={15} /> Statistiche
    </button>
  );
}

/**
 * Riepilogo della serata sulla TV: il più applaudito, la miglior intonazione, il duetto migliore e
 * chi ha cantato di più, con i totali. Il QR code apre lo stesso riepilogo sul telefono, da dove
 * si salva come immagine. Si chiude con la X, Esc o un clic fuori.
 */
export function EveningStatsPanel({ onClose }: { onClose: () => void }) {
  const [stats, setStats] = useState<EveningStats | null>(null);
  const [qr, setQr] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const load = () => api.stats().then(setStats).catch((e) => setError(e.message));
    load();
    api.statsQr().then((r) => setQr(r.qr_svg)).catch(() => {});
    const t = window.setInterval(load, 10000); // durante la festa i numeri cambiano
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const cards = stats ? statsCards(stats) : [];
  return createPortal(
    <div className="modal-back" onClick={onClose}>
      <div className="modal stats-modal" role="dialog" aria-labelledby="stats-title" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3 id="stats-title" className="grad-text">
            La serata
          </h3>
          <button type="button" className="icon-btn" title="Chiudi" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {error && <p className="muted">{error}</p>}
        {stats && (
          <>
            <div className="stats-totals">{statsTotals(stats)}</div>
            {cards.length ? (
              <div className="stats-grid">
                {cards.map((k) => {
                  const Icon = ICONS[k.key];
                  return (
                    <div className={`stats-card s-${k.key}`} key={k.key}>
                      <div className="stats-label">
                        <Icon size={16} /> {k.label}
                      </div>
                      <div className="stats-people">
                        {k.people.slice(0, 3).map((n) => (
                          <Avatar key={n} name={n} className="big" />
                        ))}
                      </div>
                      <div className="stats-names ellipsis">{k.people.join(" e ")}</div>
                      <div className="stats-main">{k.main}</div>
                      <div className="stats-detail ellipsis">{k.detail}</div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="muted">Ancora nessuna esibizione: le statistiche arrivano con i primi brani cantati.</p>
            )}
            {qr && cards.length > 0 && (
              <div className="stats-qr">
                <div className="stats-qr-img" dangerouslySetInnerHTML={{ __html: qr }} />
                <span>Inquadra il QR code per vedere il riepilogo sul telefono e salvarlo come immagine</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

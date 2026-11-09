import { Archive, FolderOpen, Loader2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, authToken } from "../shared/api";
import { fmtBytes } from "./Storage";

interface BackupEvent {
  state: "export" | "done" | "error";
  progress?: number;
  path?: string;
  size?: number;
  error?: string;
}

/** Riepilogo dell'importazione di un backup. */
function restoreSummary(r: Record<string, number>): string {
  const parts = [];
  if (r.added) parts.push(`${r.added} brani aggiunti${r.to_download ? ` (${r.to_download} da riscaricare da YouTube)` : ""}`);
  if (r.lyrics) parts.push(`${r.lyrics} testi corretti a mano`);
  if (r.scores) parts.push(`${r.scores} voti`);
  if (r.history) parts.push(`${r.history} esibizioni nei profili`);
  if (r.photos) parts.push(`${r.photos} foto`);
  return parts.length ? `Importati: ${parts.join(", ")}.` : "Niente di nuovo da importare: era già tutto qui.";
}

/**
 * Settaggi → Backup della libreria: esporta (solo dati o completo) in un .zip nella cartella
 * Download e importa un backup, anche su un altro PC.
 */
export function BackupSetting({ onError }: { onError: (m: string) => void }) {
  const [sizes, setSizes] = useState<{ data: number; full: number; folder: string } | null>(null);
  const [progress, setProgress] = useState<number | null>(null); // esportazione in corso
  const [done, setDone] = useState("");
  const [upload, setUpload] = useState<number | null>(null); // importazione: caricamento del file
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.backupInfo().then((b) => {
      setSizes(b);
      if (b.running) setProgress(0);
    }).catch(() => {});
    const on = (e: Event) => {
      const d = (e as CustomEvent<BackupEvent>).detail;
      if (d.state === "export") setProgress(d.progress ?? 0);
      else if (d.state === "done") {
        setProgress(null);
        setDone(`Backup salvato: ${d.path} (${fmtBytes(d.size ?? 0)})`);
      } else {
        setProgress(null);
        onError(`Backup non riuscito: ${d.error}`);
      }
    };
    window.addEventListener("sin-backup", on);
    return () => window.removeEventListener("sin-backup", on);
  }, [onError]);

  const exportBackup = (full: boolean) => {
    setDone("");
    setProgress(0);
    api.startBackup(full).catch((e) => {
      setProgress(null);
      onError(e.message);
    });
  };

  const importBackup = (file: File) => {
    setDone("");
    setUpload(0);
    // XMLHttpRequest: con un backup completo (GB) serve vedere l'avanzamento del caricamento
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/admin/restore");
    const token = authToken();
    if (token) xhr.setRequestHeader("X-Admin-Token", token);
    xhr.upload.onprogress = (e) => e.lengthComputable && setUpload(e.loaded / e.total);
    xhr.onload = () => {
      setUpload(null);
      try {
        const body = JSON.parse(xhr.responseText);
        if (xhr.status >= 400) onError(body.detail ?? "Importazione non riuscita");
        else setDone(restoreSummary(body));
      } catch {
        onError("Importazione non riuscita");
      }
    };
    xhr.onerror = () => {
      setUpload(null);
      onError("Importazione non riuscita");
    };
    xhr.send(file);
  };

  const busy = progress !== null || upload !== null;
  return (
    <div className="setting">
      <div className="setting-title">Backup della libreria</div>
      <p className="setting-desc">
        Esporta brani, testi (anche corretti a mano), voti, profili e foto in un file .zip nella cartella Download, per
        spostarli su un altro PC o tenerne una copia. Non contiene password.
      </p>
      <div className="backup-buttons">
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => exportBackup(false)}>
          <Archive size={15} /> Esporta solo i dati{sizes ? ` (${fmtBytes(sizes.data)})` : ""}
        </button>
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => exportBackup(true)}>
          <Archive size={15} /> Esporta tutto, con video e tracce{sizes ? ` (${fmtBytes(sizes.full)})` : ""}
        </button>
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => fileRef.current?.click()}>
          <Upload size={15} /> Importa un backup…
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) importBackup(f);
          }}
        />
      </div>
      {progress !== null && (
        <div className="backup-progress">
          <Loader2 size={15} className="spin" /> Esporto… {Math.round(progress * 100)}%
          <div className="progress">
            <div style={{ width: `${progress * 100}%` }} />
          </div>
        </div>
      )}
      {upload !== null && (
        <div className="backup-progress">
          <Loader2 size={15} className="spin" /> {upload < 1 ? `Carico il backup… ${Math.round(upload * 100)}%` : "Importo…"}
          <div className="progress">
            <div style={{ width: `${upload * 100}%` }} />
          </div>
        </div>
      )}
      {done && (
        <div className="backup-done">
          <span>{done}</span>
          {done.startsWith("Backup salvato") && (
            <button className="btn btn-ghost btn-sm" onClick={() => api.openBackupFolder().catch(() => {})}>
              <FolderOpen size={15} /> Apri la cartella
            </button>
          )}
        </div>
      )}
      <p className="setting-desc">
        Importando, i brani che mancano si aggiungono (senza video e tracce si riscaricano da YouTube, tenendo il testo del
        backup); voti, profili e foto si uniscono a quelli che ci sono già.
      </p>
    </div>
  );
}

import { Users } from "lucide-react";
import { Avatar } from "../shared/Avatar";
import { useDj } from "../shared/mode";

/** Barra laterale: QR code per scaricare l'app ed entrare dal telefono, in una card a sé. */
export function JoinCard({ qrSvg }: { qrSvg: string }) {
  return (
    <div className="join-card">
      <div className="join-qr" dangerouslySetInnerHTML={{ __html: qrSvg }} />
      <span>Inquadra il QR Code per scaricare l'app e partecipare.</span>
    </div>
  );
}

/** Barra laterale: chi è collegato dal telefono in questo momento (foto e nome). */
export function Participants({ users }: { users: string[] }) {
  const dj = useDj().toLocaleLowerCase(); // modalità DJ: etichetta «DJ» accanto al suo nome
  return (
    <div className="participants">
      <div className="participants-title">
        <Users size={18} /> Partecipanti
        {users.length > 0 && <span className="participants-count">{users.length}</span>}
      </div>
      {users.length ? (
        <ul className="participants-list">
          {users.map((u) => (
            <li key={u}>
              <Avatar name={u} className="sm" />
              <span className="ellipsis">{u}</span>
              {dj && u.toLocaleLowerCase() === dj && <span className="participants-dj">DJ</span>}
            </li>
          ))}
        </ul>
      ) : (
        <div className="participants-empty">Ancora nessuno collegato dal telefono</div>
      )}
    </div>
  );
}

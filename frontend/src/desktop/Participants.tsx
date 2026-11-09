import { Users } from "lucide-react";
import { Avatar } from "../shared/Avatar";
import { useDj } from "../shared/mode";

/**
 * Barra laterale: QR code piccolo per entrare dal telefono e, sotto, chi è collegato in questo
 * momento (foto e nome).
 */
export function Participants({ users, qrSvg }: { users: string[]; qrSvg?: string }) {
  const dj = useDj().toLocaleLowerCase(); // modalità DJ: etichetta «DJ» accanto al suo nome
  return (
    <div className="participants">
      {qrSvg && (
        <div className="participants-join">
          <div className="participants-qr" dangerouslySetInnerHTML={{ __html: qrSvg }} />
          <span>Inquadra il QR Code per scaricare l'app e partecipare.</span>
        </div>
      )}
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

import { useSyncExternalStore } from "react";
import { initials } from "./api";

/** Foto profilo dei partecipanti: nome normalizzato -> URL. Aggiornate in tempo reale via WebSocket. */
let map: Record<string, string> = {};
const listeners = new Set<() => void>();

export const avatarKey = (name: string) => name.split(/\s+/).filter(Boolean).join(" ").toLowerCase();

export function setAvatars(next: Record<string, string>) {
  map = next ?? {};
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useAvatarUrl(name: string | undefined | null): string | undefined {
  const m = useSyncExternalStore(subscribe, () => map);
  return name ? m[avatarKey(name)] : undefined;
}

/** Icona dell'utente: la sua foto se l'ha caricata, altrimenti le iniziali. */
export function Avatar({ name, className = "" }: { name: string | undefined | null; className?: string }) {
  const url = useAvatarUrl(name);
  return (
    <span className={`avatar ${url ? "has-photo" : ""} ${className}`}>
      {url ? <img src={url} alt="" /> : initials(name || "?")}
    </span>
  );
}

// ------------------------------------------------------------------ dal telefono
export async function uploadAvatar(name: string, photo: Blob) {
  const res = await fetch(`/api/avatars/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "image/jpeg" },
    body: photo,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.detail ?? "Caricamento non riuscito");
}

export async function deleteAvatar(name: string) {
  await fetch(`/api/avatars/${encodeURIComponent(name)}`, { method: "DELETE" });
}

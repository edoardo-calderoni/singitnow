/** Accesso amministratore: il gettone rilasciato dal PC è conservato sul telefono. */
const KEY = "sin.adminToken";

export const getAdminToken = () => localStorage.getItem(KEY);

/** Header da aggiungere alle richieste riservate agli amministratori. */
export const adminHeaders = (): Record<string, string> => {
  const t = getAdminToken();
  return t ? { "X-Admin-Token": t } : {};
};

/** Verifica la password sul PC; se è giusta salva il gettone. Lancia un errore se è sbagliata. */
export async function adminLogin(password: string, name: string): Promise<void> {
  const res = await fetch("/api/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password, name }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.detail ?? "Accesso non riuscito");
  localStorage.setItem(KEY, (await res.json()).token);
}

/** true se il gettone salvato è ancora valido (altrimenti lo dimentica). */
export async function adminCheck(): Promise<boolean> {
  if (!getAdminToken()) return false;
  try {
    const res = await fetch("/api/admin/check", { headers: adminHeaders() });
    const ok = !!(await res.json()).admin;
    if (!ok) localStorage.removeItem(KEY);
    return ok;
  } catch {
    return true; // PC non raggiungibile: si riverifica alla prossima connessione
  }
}

export async function adminLogout(): Promise<void> {
  await fetch("/api/admin/logout", { method: "POST", headers: adminHeaders() }).catch(() => {});
  localStorage.removeItem(KEY);
}

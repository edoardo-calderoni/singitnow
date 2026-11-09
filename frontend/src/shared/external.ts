/**
 * Apre un link esterno (es. il video su YouTube) fuori da SingITnow:
 * nella finestra del PC con il browser di Windows, nell'app Android con l'app YouTube o il browser,
 * nel browser del telefono in una nuova scheda.
 */
export function openExternal(url: string) {
  const w = window as any;
  if (w.pywebview?.api?.open_url) w.pywebview.api.open_url(url);
  else if (typeof w.SingITnowApp?.openUrl === "function") w.SingITnowApp.openUrl(url);
  else window.open(url, "_blank", "noopener");
}

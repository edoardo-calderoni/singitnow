import { useEffect, useRef, useState } from "react";

/** Brano che si sta trascinando: da quale posizione, verso quale, e di quanto si è mosso il dito. */
export interface DragState {
  id: string;
  from: number;
  to: number;
  dy: number;
  height: number; // altezza della riga trascinata + spazio tra le righe
}

const HOLD_MS = 450; // quanto tenere premuto prima che la riga si stacchi
const MOVE_TOLERANCE = 10; // px: se il dito si sposta prima, è uno scorrimento della pagina

/**
 * Riordino col dito: tenendo premuta una riga (li[data-entry-id]) la si trascina su e giù.
 * Al rilascio chiama onDrop(id, delta) con lo spostamento in posizioni.
 * Usa eventi touch non passivi, così durante il trascinamento la pagina non scorre.
 */
export function useReorder(
  list: HTMLElement | null, // la lista (da un ref a callback: può comparire dopo, quando arriva la coda)
  enabled: boolean,
  onDrop: (id: string, delta: number) => void,
) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  useEffect(() => {
    if (!list || !enabled) return;
    let timer: number | undefined;
    let startY = 0;
    let active: DragState | null = null;
    let mids: number[] = []; // centro verticale di ogni riga all'inizio del trascinamento
    let rowEl: HTMLElement | null = null;

    const rows = () => Array.from(list.querySelectorAll<HTMLElement>("li[data-entry-id]"));

    const start = (li: HTMLElement) => {
      const all = rows();
      const from = all.indexOf(li);
      if (from < 0) return;
      mids = all.map((r) => {
        const b = r.getBoundingClientRect();
        return b.top + b.height / 2;
      });
      const next = all[from + 1] ?? all[from - 1];
      const rect = li.getBoundingClientRect();
      const gap = next ? Math.abs(next.getBoundingClientRect().top - rect.top) - rect.height : 8;
      active = { id: li.dataset.entryId!, from, to: from, dy: 0, height: rect.height + Math.max(gap, 0) };
      rowEl = li;
      setDrag({ ...active });
      navigator.vibrate?.(20);
    };

    const move = (y: number) => {
      if (!active) return;
      const dy = y - startY;
      const center = mids[active.from] + dy;
      // nuova posizione: quante righe (esclusa questa) hanno il centro sopra quello della riga trascinata
      let to = 0;
      mids.forEach((m, i) => {
        if (i !== active!.from && m < center) to++;
      });
      active = { ...active, dy, to };
      setDrag(active);
    };

    const end = () => {
      window.clearTimeout(timer);
      if (active) {
        const { id, from, to } = active;
        active = null;
        rowEl = null;
        setDrag(null);
        if (to !== from) onDropRef.current(id, to - from);
      }
    };

    const onTouchStart = (e: TouchEvent) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>("li[data-entry-id]");
      // i pulsanti della riga (cestino) restano pulsanti
      if (!li || (e.target as HTMLElement).closest("button")) return;
      startY = e.touches[0].clientY;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => start(li), HOLD_MS);
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0].clientY;
      if (!active) {
        if (Math.abs(y - startY) > MOVE_TOLERANCE) window.clearTimeout(timer); // sta scorrendo la pagina
        return;
      }
      e.preventDefault(); // niente scorrimento mentre si trascina
      move(y);
    };
    // menu del tasto lungo (copia, condividi…) disattivato sulle righe trascinabili
    const onContextMenu = (e: Event) => {
      if ((e.target as HTMLElement).closest("li[data-entry-id]")) e.preventDefault();
    };

    // mouse (PC, prove): stessa logica con i pointer events
    const onMouseDown = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" || e.button !== 0) return;
      const li = (e.target as HTMLElement).closest<HTMLElement>("li[data-entry-id]");
      if (!li || (e.target as HTMLElement).closest("button")) return;
      startY = e.clientY;
      timer = window.setTimeout(() => start(li), HOLD_MS);
    };
    const onMouseMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      if (!active) {
        if (Math.abs(e.clientY - startY) > MOVE_TOLERANCE) window.clearTimeout(timer);
        return;
      }
      move(e.clientY);
    };

    list.addEventListener("touchstart", onTouchStart, { passive: true });
    list.addEventListener("touchmove", onTouchMove, { passive: false });
    list.addEventListener("touchend", end);
    list.addEventListener("touchcancel", end);
    list.addEventListener("contextmenu", onContextMenu);
    list.addEventListener("pointerdown", onMouseDown);
    window.addEventListener("pointermove", onMouseMove);
    window.addEventListener("pointerup", end);
    return () => {
      window.clearTimeout(timer);
      list.removeEventListener("touchstart", onTouchStart);
      list.removeEventListener("touchmove", onTouchMove);
      list.removeEventListener("touchend", end);
      list.removeEventListener("touchcancel", end);
      list.removeEventListener("contextmenu", onContextMenu);
      list.removeEventListener("pointerdown", onMouseDown);
      window.removeEventListener("pointermove", onMouseMove);
      window.removeEventListener("pointerup", end);
      void rowEl;
    };
  }, [list, enabled]);

  /** Stile di ogni riga durante il trascinamento: quella presa segue il dito, le altre le fanno spazio. */
  const styleFor = (id: string, index: number): React.CSSProperties | undefined => {
    if (!drag) return undefined;
    if (id === drag.id) return { transform: `translateY(${drag.dy}px) scale(1.03)`, zIndex: 5, transition: "none" };
    let shift = 0;
    if (drag.from < drag.to && index > drag.from && index <= drag.to) shift = -drag.height;
    if (drag.from > drag.to && index < drag.from && index >= drag.to) shift = drag.height;
    return { transform: `translateY(${shift}px)` };
  };

  return { drag, styleFor };
}

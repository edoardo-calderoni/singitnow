/** Statistiche della serata: dati dal PC, schede del riepilogo e immagine da salvare. */

export interface StatsShow {
  song_id: string;
  title: string;
  artist: string;
  singers: string[];
  applause: number;
  score: number | null;
}

export interface EveningStats {
  started: number;
  now: number;
  performances: number;
  singers: number;
  applause: number;
  most_applauded: StatsShow | null;
  best_pitch: { singer: string; score: number; title: string; song_id: string } | null;
  best_duet: StatsShow | null;
  most_songs: { singers: string[]; count: number } | null;
}

export interface StatsCard {
  key: "applause" | "pitch" | "duet" | "songs";
  label: string;
  people: string[]; // foto e nomi
  main: string; // valore in evidenza
  detail: string; // brano o spiegazione
}

const joinNames = (names: string[]) =>
  names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} e ${names[names.length - 1]}`;

/** Le schede del riepilogo, nell'ordine in cui si mostrano (solo quelle con dei dati). */
export function statsCards(s: EveningStats): StatsCard[] {
  const cards: StatsCard[] = [];
  if (s.most_applauded)
    cards.push({
      key: "applause",
      label: "Il più applaudito",
      people: s.most_applauded.singers,
      main: `${s.most_applauded.applause} applausi`,
      detail: `«${s.most_applauded.title}»`,
    });
  if (s.best_pitch)
    cards.push({
      key: "pitch",
      label: "Miglior intonazione",
      people: [s.best_pitch.singer],
      main: `${s.best_pitch.score}/100`,
      detail: `«${s.best_pitch.title}»`,
    });
  if (s.best_duet)
    cards.push({
      key: "duet",
      label: "Il duetto migliore",
      people: s.best_duet.singers,
      main: s.best_duet.score != null ? `${s.best_duet.score}/100` : `${s.best_duet.applause} applausi`,
      detail: `«${s.best_duet.title}»`,
    });
  if (s.most_songs)
    cards.push({
      key: "songs",
      label: s.most_songs.singers.length > 1 ? "Hanno cantato di più" : "Ha cantato di più",
      people: s.most_songs.singers,
      main: `${s.most_songs.count} ${s.most_songs.count === 1 ? "brano" : "brani"}`,
      detail: joinNames(s.most_songs.singers),
    });
  return cards;
}

/** Durata della serata, es. «3 h 20 min». */
export function fmtDuration(seconds: number): string {
  const m = Math.max(0, Math.round(seconds / 60));
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

/** Riga dei totali, es. «12 esibizioni · 7 cantanti · 85 applausi · 3 h 20 min». */
export function statsTotals(s: EveningStats): string {
  return [
    `${s.performances} ${s.performances === 1 ? "esibizione" : "esibizioni"}`,
    `${s.singers} ${s.singers === 1 ? "cantante" : "cantanti"}`,
    `${s.applause} applausi`,
    fmtDuration(s.now - s.started),
  ].join(" · ");
}

const loadImage = (src: string) =>
  new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });

/** Riepilogo come immagine PNG (formato verticale, da condividere), con le foto di chi c'è. */
export async function statsImage(s: EveningStats, avatarUrl: (name: string) => string): Promise<Blob> {
  const W = 1080;
  const cards = statsCards(s);
  const H = 420 + cards.length * 250 + 140;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#1a1033");
  bg.addColorStop(1, "#0b0b14");
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  const accent = g.createLinearGradient(0, 0, W, 0);
  accent.addColorStop(0, "#ff3d9a");
  accent.addColorStop(0.55, "#8b5cf6");
  accent.addColorStop(1, "#22d3ee");

  g.textAlign = "center";
  g.fillStyle = accent;
  g.font = "700 84px system-ui, sans-serif";
  g.fillText("La serata", W / 2, 170);
  g.fillStyle = "#c9c6e8";
  g.font = "400 38px system-ui, sans-serif";
  g.fillText(new Date(s.started * 1000).toLocaleDateString("it-IT", { day: "numeric", month: "long", year: "numeric" }), W / 2, 240);
  g.font = "400 34px system-ui, sans-serif";
  g.fillText(statsTotals(s), W / 2, 310);

  const photos = new Map<string, HTMLImageElement | null>();
  await Promise.all(
    [...new Set(cards.flatMap((k) => k.people))].map(async (n) => photos.set(n, await loadImage(avatarUrl(n)))),
  );

  let y = 400;
  for (const k of cards) {
    g.fillStyle = "rgba(255,255,255,0.06)";
    g.beginPath();
    g.roundRect(60, y, W - 120, 220, 32);
    g.fill();
    // foto (al massimo due, affiancate)
    k.people.slice(0, 2).forEach((n, i) => {
      const x = 150 + i * 70;
      const img = photos.get(n);
      g.save();
      g.beginPath();
      g.arc(x, y + 110, 62, 0, Math.PI * 2);
      g.closePath();
      g.fillStyle = "#2a2647";
      g.fill();
      if (img) {
        g.clip();
        g.drawImage(img, x - 62, y + 48, 124, 124);
      } else {
        g.fillStyle = "#f4f3ff";
        g.font = "700 56px system-ui, sans-serif";
        g.textAlign = "center";
        g.fillText(n.slice(0, 1).toUpperCase(), x, y + 130);
      }
      g.restore();
    });
    const tx = k.people.length > 1 ? 330 : 260;
    g.textAlign = "left";
    g.fillStyle = "#a5a1cf";
    g.font = "600 30px system-ui, sans-serif";
    g.fillText(k.label.toUpperCase(), tx, y + 62);
    g.fillStyle = "#ffffff";
    g.font = "700 44px system-ui, sans-serif";
    g.fillText(fit(g, joinNames(k.people), W - tx - 100), tx, y + 118);
    g.fillStyle = "#fbbf24";
    g.font = "700 36px system-ui, sans-serif";
    g.fillText(k.main, tx, y + 170);
    const mw = g.measureText(k.main).width;
    g.fillStyle = "#c9c6e8";
    g.font = "400 32px system-ui, sans-serif";
    g.fillText(fit(g, "  " + k.detail, W - tx - mw - 100), tx + mw, y + 170);
    y += 250;
  }
  g.textAlign = "center";
  g.fillStyle = accent;
  g.font = "700 40px system-ui, sans-serif";
  g.fillText("SingITnow", W / 2, H - 70);

  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("Immagine non creata"))), "image/png"));
}

/** Testo accorciato con «…» perché stia nella larghezza data. */
function fit(g: CanvasRenderingContext2D, text: string, width: number): string {
  if (g.measureText(text).width <= width) return text;
  let t = text;
  while (t.length > 1 && g.measureText(t + "…").width > width) t = t.slice(0, -1);
  return t + "…";
}

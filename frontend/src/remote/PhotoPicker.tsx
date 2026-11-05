import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Camera, Check, ImagePlus, Trash2, X, ZoomIn } from "lucide-react";

const OUT = 320; // lato della foto profilo salvata (pixel)
const STAGE = 280; // lato dell'area di inquadratura sullo schermo (pixel CSS)
const RING = 14; // margine del cerchio dal bordo (deve coincidere con .m-ring in remote.css)

/** La fotocamera dentro la pagina è concessa dal browser solo su connessione sicura (HTTPS/localhost). */
const liveCameraAvailable = () =>
  window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;

function toJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Foto non leggibile"))),
      "image/jpeg",
      0.85,
    ),
  );
}

/**
 * Foto profilo: anteprima tonda + "Scatta una foto" / "Dalla galleria".
 * Prima di salvare si inquadra sempre il viso dentro il cerchio (trascinando e con lo zoom).
 */
export function PhotoPicker({
  preview,
  onPick,
  onRemove,
}: {
  preview: string | null;
  onPick: (photo: Blob) => void;
  onRemove?: () => void;
}) {
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const shootRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  const openFile = (f: File | undefined) => {
    if (f) setCropSrc(URL.createObjectURL(f));
  };

  return (
    <div className="m-photo">
      <div className="m-photo-preview">
        {preview ? (
          <img src={preview} alt="La tua foto" />
        ) : (
          <Camera size={34} />
        )}
      </div>
      <div className="m-photo-actions">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() =>
            liveCameraAvailable() ? setLive(true) : shootRef.current?.click()
          }
        >
          <Camera size={16} /> Scatta una foto
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => galleryRef.current?.click()}
        >
          <ImagePlus size={16} /> Dalla galleria
        </button>
        {preview && onRemove && (
          <button
            type="button"
            className="btn btn-ghost btn-sm danger"
            onClick={onRemove}
          >
            <Trash2 size={16} /> Togli
          </button>
        )}
      </div>
      {/* fotocamera nativa (frontale) e galleria */}
      <input
        ref={shootRef}
        type="file"
        accept="image/*"
        capture="user"
        hidden
        onChange={(e) => (openFile(e.target.files?.[0]), (e.target.value = ""))}
      />
      <input
        ref={galleryRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => (openFile(e.target.files?.[0]), (e.target.value = ""))}
      />

      {live &&
        createPortal(
          <LiveCamera
            onShot={(url) => {
              setLive(false);
              setCropSrc(url);
            }}
            onFallback={() => {
              setLive(false);
              shootRef.current?.click();
            }}
            onCancel={() => setLive(false)}
          />,
          document.body,
        )}
      {cropSrc &&
        createPortal(
          <CropEditor
            src={cropSrc}
            onCancel={() => {
              URL.revokeObjectURL(cropSrc);
              setCropSrc(null);
            }}
            onDone={(blob) => {
              URL.revokeObjectURL(cropSrc);
              setCropSrc(null);
              onPick(blob);
            }}
          />,
          document.body,
        )}
    </div>
  );
}

// ------------------------------------------------------------------ fotocamera con il cerchio
function LiveCamera({
  onShot,
  onFallback,
  onCancel,
}: {
  onShot: (url: string) => void;
  onFallback: () => void;
  onCancel: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    let stopped = false;
    navigator.mediaDevices
      .getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 } },
        audio: false,
      })
      .then((s) => {
        if (stopped) return s.getTracks().forEach((t) => t.stop());
        streamRef.current = s;
        videoRef.current!.srcObject = s;
      })
      .catch(onFallback); // permesso negato o nessuna fotocamera: fotocamera nativa
    return () => {
      stopped = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shoot = () => {
    const v = videoRef.current!;
    if (!v.videoWidth) return;
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const ctx = c.getContext("2d")!;
    ctx.translate(c.width, 0);
    ctx.scale(-1, 1); // come in uno specchio, come l'utente si vedeva
    ctx.drawImage(v, 0, 0);
    toJpeg(c).then((b) => onShot(URL.createObjectURL(b)));
  };

  return (
    <div className="m-sheet">
      <div className="m-sheet-card">
        <div className="m-sheet-title">Metti il viso dentro il cerchio</div>
        <div className="m-stage" style={{ width: STAGE, height: STAGE }}>
          <video
            ref={videoRef}
            className="m-stage-video"
            autoPlay
            playsInline
            muted
          />
          <div className="m-ring" />
        </div>
        <div className="m-sheet-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            <X size={16} /> Annulla
          </button>
          <button type="button" className="btn btn-primary" onClick={shoot}>
            <Camera size={16} /> Scatta
          </button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ inquadratura nel cerchio
function CropEditor({
  src,
  onDone,
  onCancel,
}: {
  src: string;
  onDone: (b: Blob) => void;
  onCancel: () => void;
}) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 }); // spostamento del centro della foto (pixel CSS)
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    px: number;
    py: number;
  } | null>(null);

  useEffect(() => {
    const i = new Image();
    i.onload = () => setImg(i);
    i.src = src;
  }, [src]);

  const base = img ? STAGE / Math.min(img.naturalWidth, img.naturalHeight) : 1; // la foto copre tutto il quadrato
  const scale = base * zoom;
  const w = (img?.naturalWidth ?? 0) * scale;
  const h = (img?.naturalHeight ?? 0) * scale;
  // la foto non deve mai lasciare scoperta l'area del cerchio
  const clamp = (p: { x: number; y: number }) => ({
    x: Math.max(-(w - STAGE) / 2, Math.min((w - STAGE) / 2, p.x)),
    y: Math.max(-(h - STAGE) / 2, Math.min((h - STAGE) / 2, p.y)),
  });
  const p = clamp(pos);
  const left = STAGE / 2 - w / 2 + p.x;
  const top = STAGE / 2 - h / 2 + p.y;

  const save = () => {
    if (!img) return;
    const c = document.createElement("canvas");
    c.width = c.height = OUT;
    // si salva esattamente il quadrato che contiene il cerchio: la foto sulla TV sarà come inquadrata
    const side = (STAGE - 2 * RING) / scale;
    c.getContext("2d")!.drawImage(
      img,
      (RING - left) / scale,
      (RING - top) / scale,
      side,
      side,
      0,
      0,
      OUT,
      OUT,
    );
    toJpeg(c).then(onDone);
  };

  return (
    <div className="m-sheet">
      <div className="m-sheet-card">
        <div className="m-sheet-title">
          Sposta e ingrandisci la foto finché il viso è nel cerchio
        </div>
        <div
          className="m-stage"
          style={{ width: STAGE, height: STAGE, touchAction: "none" }}
          onPointerDown={(e) => {
            (e.target as Element).setPointerCapture?.(e.pointerId);
            drag.current = {
              id: e.pointerId,
              x: e.clientX,
              y: e.clientY,
              px: p.x,
              py: p.y,
            };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (d && d.id === e.pointerId)
              setPos({ x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y });
          }}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
        >
          {img && (
            <img
              src={src}
              alt=""
              draggable={false}
              style={{ position: "absolute", left, top, width: w, height: h }}
            />
          )}
          <div className="m-ring" />
        </div>
        <label className="m-zoom">
          <ZoomIn size={18} />
          <input
            type="range"
            min={1}
            max={3}
            step={0.01}
            value={zoom}
            aria-label="Zoom"
            style={{ ["--val" as string]: `${((zoom - 1) / 2) * 100}%` }}
            onChange={(e) => setZoom(parseFloat(e.target.value))}
          />
        </label>
        <div className="m-sheet-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            <X size={16} /> Annulla
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={save}
            disabled={!img}
          >
            <Check size={16} /> Usa questa foto
          </button>
        </div>
      </div>
    </div>
  );
}

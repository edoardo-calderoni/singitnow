# SingITnow 🎤

Karaoke tra amici: il PC collegato alla TV fa da palco, i partecipanti prenotano le canzoni dal telefono.

- **Cerca su YouTube** il videoclip di una canzone e aggiungilo alla libreria.
- In automatico SingITnow **scarica il video**, **separa la voce dalla base musicale** (AI) e **sincronizza il testo parola per parola** con la voce originale.
- Durante il karaoke il video scorre con **il testo a tutto schermo che si colora mentre va cantato**. La **voce guida** si regola da 0% (solo base) al volume pieno.
- Gli ospiti inquadrano il **QR code** e dal telefono prenotano i brani, vedono la coda e la riordinano (nessuna app da installare).

## Requisiti

- Windows 11
- [Python](https://www.python.org/) 3.10+ (l'ambiente usa Python 3.12, scaricato in automatico)
- [Node.js](https://nodejs.org/) 20+ (serve a compilare l'interfaccia e a yt-dlp per YouTube)
- [FFmpeg](https://ffmpeg.org/) nel PATH (`winget install Gyan.FFmpeg`)
- PC e telefoni sulla stessa rete Wi-Fi

## Installazione

```powershell
powershell -ExecutionPolicy Bypass -File setup.ps1
```

Poi avvia con **`SingITnow.bat`**. Al primo avvio Windows chiede di consentire l'accesso alla rete: accetta per le reti private, altrimenti i telefoni non si collegano.

Al primo brano elaborato vengono scaricati i modelli AI (circa 550 MB) in `data/models/`.

Opzioni di avvio:

```powershell
.venv\Scripts\python -m singitnow            # finestra nativa
.venv\Scripts\python -m singitnow --browser  # nel browser predefinito
.venv\Scripts\python -m singitnow --server   # solo server
```

## Come funziona

```
YouTube ──yt-dlp──▶ video.mp4 ──ffmpeg──▶ audio ──MDX-Net (audio-separator)──▶ vocals + instrumental
                                                                                     │
                     LRCLIB (testo ufficiale) ──┐                                    │
                                                ├── allineamento ◀── Whisper (tempo di ogni parola cantata)
                                                ▼
                                           lyrics.json
```

1. **Download**: yt-dlp scarica il video (max 1080p, H.264).
2. **Separazione**: un modello MDX-Net divide voce e base. Su CPU richiede circa 1,5 minuti per brano.
3. **Testo**: il testo ufficiale arriva da [LRCLIB](https://lrclib.net). Whisper ascolta la voce isolata e ricava il momento esatto di ogni parola. Le parole del testo ufficiale vengono allineate a quelle cantate, così il testo segue *questo* video anche quando ha un'intro diversa dalla versione album. Se il testo non si trova online, si usa direttamente la trascrizione di Whisper.
4. **Lingua**: Whisper la riconosce dalla voce e serve al filtro della libreria (si può correggere a mano).

Il player riproduce base e voce con la Web Audio API, sincronizzate al campione, e il video (muto) segue l'orologio audio.

## Uso

| Dove | Cosa |
|---|---|
| **Libreria** | Ricerca per titolo/artista, filtro lingua, *Canta* (avvio immediato), aggiunta in coda, ✏️ per correggere artista/titolo/lingua e rigenerare il testo |
| **Cerca su YouTube** | Cerca e *Aggiungi alla libreria*: l'elaborazione parte in background |
| **Playlist** | Coda dei cantanti: riordina, avvia, rimuovi |
| **Player** | `Spazio` play/pausa · `←/→` ±5 s · `V` voce guida on/off · `F` schermo intero · `Esc` chiudi. Il pulsante ⏱ corregge l'anticipo/ritardo del testo (memorizzato per brano) |
| **Telefono** | Nome → *Brani* (prenota) · *YouTube* (scarica e prenota) · *Playlist* (coda, riordino, pausa e voce guida a distanza) |

Negli ultimi 30 secondi di un brano compare l'annuncio **«Sta per iniziare…»** con conto alla rovescia, e allo zero parte il cantante successivo.

## Configurazione (variabili d'ambiente)

| Variabile | Default | Note |
|---|---|---|
| `SINGITNOW_PORT` | `8765` | |
| `SINGITNOW_DATA` | `./data` | libreria, modelli, log |
| `SINGITNOW_SEPARATION_MODEL` | `UVR-MDX-NET-Inst_HQ_3.onnx` | es. `model_bs_roformer_ep_317_sdr_12.9755.ckpt` (qualità più alta, molto più lento su CPU) |
| `SINGITNOW_WHISPER_MODEL` | `small` | `base` più veloce, `medium` più preciso |

## Sviluppo

```powershell
.venv\Scripts\python -m singitnow --server   # backend su :8765
cd frontend; npm run dev                     # interfaccia con hot reload su :5173 (/ e /remote.html)
```

Struttura:

```
singitnow/          backend Python (FastAPI)
  app.py            API REST + WebSocket + file statici
  pipeline.py       download → separazione → testo (worker in background)
  youtube.py        ricerca e download (yt-dlp)
  audio.py          ffmpeg + separazione voce (audio-separator)
  lyrics.py         LRCLIB + Whisper + allineamento parole
  library.py        libreria su disco (data/library/<id>/)
  playlist.py       coda dei cantanti
frontend/           React + TypeScript (Vite)
  src/desktop/      app per PC/TV (libreria, ricerca, player)
  src/remote/       app per i telefoni (PWA)
  src/shared/       API, stato in tempo reale, motore audio
```

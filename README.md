# SingITnow 🎤

Karaoke tra amici: il PC collegato alla TV fa da palco, i partecipanti prenotano le canzoni dal telefono.

- **Cerca su YouTube** il videoclip di una canzone e aggiungilo alla libreria.
- In automatico SingITnow **scarica il video**, **separa la voce dalla base musicale** (AI) e **sincronizza il testo parola per parola** con la voce originale.
- Durante il karaoke il video scorre con **il testo a tutto schermo che si colora mentre va cantato**. La **voce guida** si regola da 0% (solo base) al volume pieno.
- Gli ospiti inquadrano il **QR code** e dal telefono prenotano i brani, vedono la coda e la riordinano (nessuna app da installare).

## App sul telefono

Inquadrando il QR code si apre la pagina di SingITnow; in cima compare l'invito a installarla:

- **Android**: *Scarica l'app* scarica dal PC una piccola app (`SingITnow.apk`) che apre SingITnow a tutto schermo, senza barra del browser. Al primo avvio cerca da sola il PC sulla rete Wi-Fi (porta 8765) e si ricorda l'indirizzo; se non lo trova (es. SingITnow sul PC non è ancora aperto) continua a cercarlo da sola e si apre appena lo trova. Per gli amministratori i tasti del volume regolano il volume della TV. Android chiede di consentire l'installazione da Chrome (solo la prima volta): è normale per le app che non arrivano dal Play Store.
- **iPhone**: istruzioni per *Condividi → Aggiungi alla schermata Home*; da lì SingITnow si apre a tutto schermo, come un'app.

L'app Android si ricompila con `powershell -ExecutionPolicy Bypass -File androiduild.ps1` (serve l'SDK di Android, cioè Android Studio, e un JDK 17+): il file finisce in `singitnow/static/SingITnow.apk`, da dove il PC lo offre ai telefoni.

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

Il setup crea anche il collegamento **SingITnow** (con il logo) sul desktop e nel menu Start; in alternativa avvia con **`SingITnow.bat`**. Per ricreare il collegamento: `powershell -ExecutionPolicy Bypass -File shortcut.ps1`.

Il setup apre nel firewall di Windows la porta 8765, solo sulle reti private. Se inquadrando il QR code il telefono resta su una pagina nera o non carica:

- esegui `powershell -ExecutionPolicy Bypass -File firewall.ps1` (chiede i permessi di amministratore);
- controlla che la rete Wi-Fi sia impostata come **Privata** in Windows;
- verifica che telefono e PC siano sulla stessa rete (niente rete ospiti).

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
2. **Separazione**: un modello MDX-Net divide voce e base. Usa la scheda video con DirectML (qualsiasi GPU su Windows: AMD, NVIDIA, Intel), in pochi secondi a brano (con una Radeon RX 9070 XT circa 4 s per minuto di audio, contro i 33 s della CPU); senza GPU compatibile, o se la GPU dà errore, si passa da soli alla CPU (circa 2 minuti a brano). Whisper resta sulla CPU: CTranslate2 usa la GPU solo con CUDA (NVIDIA).
3. **Testo**: il testo ufficiale arriva da [LRCLIB](https://lrclib.net). Whisper ascolta la voce isolata e ricava il momento esatto di ogni parola. Le parole del testo ufficiale vengono allineate a quelle cantate, così il testo segue *questo* video anche quando ha un'intro diversa dalla versione album. Se il testo non si trova online, si usa direttamente la trascrizione di Whisper.
4. **Ritmo**: dalla base strumentale si ricava la griglia delle battute (BPM, battiti e primo tempo della battuta) all'inizio e alla fine del brano, e dove il brano inizia e finisce di sentirsi (senza i silenzi), per il mix in battuta delle modalità DJ e Jukebox (`beats.json`, pochi secondi per brano; per i brani già in libreria viene calcolata all'avvio).
5. **Note**: dalla voce isolata si ricava la melodia (pYIN di librosa) per le barre dell'intonazione; ogni parola del testo ha la sua barra, e quelle dove la voce non si riconosce con sicurezza sono «incerte» (si vedono ma non contano nel punteggio) (`pitch.json`, circa 15 secondi per brano; per i brani già in libreria viene calcolata all'avvio).
6. **Lingua**: Whisper la riconosce dalla voce e serve al filtro della libreria (si può correggere a mano).

Il player riproduce base e voce con la Web Audio API, sincronizzate al campione, e il video (muto) segue l'orologio audio.

## Uso

| Dove | Cosa |
|---|---|
| **Libreria** | Ricerca per titolo/artista, filtro lingua, *Aggiungi* mette il brano in coda (in Karaoke si sceglie chi canta tra gli utenti collegati dal telefono, oppure si lascia vuoto), ✏️ per correggere artista/titolo/lingua e rigenerare il testo, oppure *Modifica testo* per correggerlo a mano (una riga per ogni riga del karaoke; salvando, le parole vengono rimesse a tempo con la voce in qualche decina di secondi) |
| **Nuovo brano** | Pulsante in alto nella libreria, apre il pannello *Aggiungi brano*: cerca su YouTube (oppure incolla il link di un video di YouTube: compare subito quel video; in fondo *Carica altri risultati* ne mostra altri 12 alla volta, fino a 60) e *Aggiungi alla libreria*, l'elaborazione parte in background |
| **Playlist** | Coda dei cantanti: riordina, rimuovi, *Avvia playlist*. I brani aggiunti dal PC o da un amministratore non partono da soli; quelli prenotati dagli utenti dal telefono partono subito se la playlist è ferma (si può disattivare con *Riproduzione automatica* nei *Settaggi*, l'ingranaggio accanto al logo). Con *Blocca inserimenti e richieste* (sempre nei *Settaggi*) nessuno aggiunge o chiede brani, neanche il DJ, e la playlist la gestiscono solo il PC e gli amministratori: agli altri sparisce la scheda *Libreria*, non tolgono più i propri brani e il DJ perde la scheda *Richieste* e la card «Sei il DJ della serata!» |
| **Player** | `Spazio` play/pausa · `←/→` ±5 s · `V` voce guida on/off · `+`/`-` tonalità · sopra i comandi, volume e muto dei microfoni (uno o due: regolano il microfono in Windows, da cui la voce va alle casse con «Ascolta questo dispositivo») · `F` schermo intero · `Esc` esce dallo schermo intero (il brano si chiude solo con Stop o con la X in alto a destra) · la **freccia in alto a sinistra** torna alla schermata principale senza fermare il brano, che continua in una finestrella in basso a destra: passandoci sopra col mouse compaiono play/pausa, *Torna a schermo intero* (anche con doppio clic) e la X che ferma il brano; anche i brani successivi restano nella finestrella finché non la si rimette a tutto schermo (se la musica si ferma del tutto, il prossimo avvio torna a tutto schermo) |
| **Schermo intero** | L'app si apre a schermo intero. In qualsiasi schermata `Esc` esce dallo schermo intero, `F` o `F11` lo rimettono |
| **Chiusura** | Se si chiude l'app mentre un brano si sta importando, un avviso chiede conferma: con *No* l'app resta aperta; con *Sì* l'importazione si interrompe e di quel brano viene cancellato tutto (file scaricati e generati, prenotazioni in coda); eventuali file ancora bloccati spariscono al prossimo avvio |
| **Partecipanti** | Nella barra laterale, sotto le modalità: QR code piccolo per entrare dal telefono e, sotto, foto e nome di chi è collegato in questo momento. Un amministratore può anche mostrare il QR in grande per 10 s nell'angolo della TV (*Settaggi* → *App per gli ospiti*) |
| **Autotune** | Accanto ai microfoni (barra del player e telefono degli amministratori, anche in *Settaggi* → *Microfoni*): corregge l'intonazione di chi canta verso la **melodia del brano** (all'ottava di chi canta; fra una nota e l'altra verso il semitono più vicino), con intensità *Leggero* / *Medio* / *Robotico*. Per farlo la voce dei microfoni passa da SingITnow invece che da Windows: un motore audio a parte (processo separato, WASAPI a bassa latenza, ~35–50 ms complessivi, simile ad «Ascolta questo dispositivo») prende i microfoni, li corregge e li manda alle casse. In Windows va disattivato una volta «Ascolta questo dispositivo» sui microfoni (l'app avvisa se è ancora attivo); *Voce dei microfoni → Windows* torna come prima |
| **Competizione** | Interruttore sotto Karaoke/Jukebox (sul PC e nei *Settaggi* degli amministratori; solo in Karaoke). Si accende solo con un microfono collegato e con altri partecipanti collegati dal telefono (altrimenti un avviso lo spiega). Si può accendere anche a playlist in corsa: conta dal brano successivo a quello che sta suonando (se era l'ultimo, a fine playlist non c'è classifica). Una sessione va dal primo brano avviato a musica ferma a quando la musica si ferma del tutto: a inizio sessione la classifica si svuota. Contano solo i brani con un cantante; chi canta più brani ha la **media** dei suoi voti d'intonazione. Dopo ogni brano la scheda del voto mostra la classifica della sessione; a fine playlist coriandoli, applausi e coppa con foto, media e voti del vincitore. A sessione finita il pulsante *Classifica* sotto l'interruttore la rimostra. Dal telefono, *Mostra la classifica sulla TV* la fa comparire per 10 s nell'angolo in alto a destra (lontano dal testo) |
| **Telefono** | Nome → *Libreria* (prenota; *Nuovo brano* per cercare su YouTube, o incollare il link di un video, scaricare e prenotare) · *Live* (brano in corso e coda, si tolgono le proprie prenotazioni) · *Testo* (testo in tempo reale). Un solo brano in coda per persona: «Prima esibisciti e poi aggiungi un altro brano». Gli amministratori (interruttore **ADMIN**) in più: brani in coda senza limiti, pausa, stop, brano successivo, volume generale e della voce, tonalità della base, volume e muto dei microfoni (due cursori se i microfoni sono due; anche dalla scheda *Settaggi* → *Microfoni*), riordino ed eliminazione di qualsiasi brano in coda, pulsante *Avvia playlist*, quarta scheda in basso **Settaggi** con *Modalità della serata*, *App per gli ospiti* (QR code d'ingresso per 10 s nell'angolo della TV, sempre disponibile), scheda *Wi-Fi per gli ospiti*: si imposta una volta la rete di casa (nome, sicurezza, password; *Rileva la rete → Dal telefono*, nell'app Android dalla versione 1.3, legge il nome della rete a cui è collegato il telefono, con il permesso di posizione richiesto da Android, e la password si scrive a mano; *Dal PC* la legge da Windows se il PC è in Wi-Fi) e *Mostra il QR sulla TV* fa comparire per 10 s (come il QR d'ingresso) il QR code che collega al Wi-Fi senza digitare la password (si inquadra con la fotocamera; un clic sulla TV lo chiude). La rete resta salvata sul PC in `data/settings.json` e la vedono solo gli amministratori |
| **Duetto** | Solo in Karaoke. Nel *Live*, sotto un proprio brano in coda, *Proponi duetto* (compare solo se c'è almeno un altro utente collegato dal telefono) apre l'elenco di chi è collegato: si sceglie con chi cantare. All'invitato il telefono vibra e compare la proposta (chi la fa, brano, fra quanto tocca) con *Accetta* / *Rifiuta*; chi propone vede «In attesa di …» (può ritirarla) e poi riceve la risposta. Se accetta, nella card del brano in coda (telefoni e PC) compaiono i due cantanti con l'etichetta **Duetto**, e sulla TV l'avviso «<nome> e <nome> canteranno in duetto!». Anche chi si è unito riceve «Fra poco tocca a te», passa al testo quando parte il brano e non vede il pulsante degli applausi; sulla TV il brano si presenta come «Duetto: Anna & Marco». Con due microfoni il secondo è di chi si è unito (nome sulle barre dell'intonazione e voto suo); con un microfono solo il voto va a entrambi. Il duetto non conta come brano in coda per chi si è unito (può prenotarne uno suo). Una proposta alla volta per brano; il duetto si annulla dalla card (chi l'ha prenotato, chi si è unito o un amministratore), e l'altro riceve un avviso. Le proposte valgono finché il brano è in coda |

**Intonazione** (modalità Karaoke): con un microfono collegato al PC, in alto sullo schermo scorrono le note della melodia (ricavate dalla voce originale isolata) e sopra si disegna la voce di chi canta, colorata quando è intonata (va bene anche un'ottava sopra o sotto). Il punteggio cresce mentre si canta; a fine brano compare sulla TV il voto su 100 con la **classifica della serata**, che si vede anche dal telefono nella scheda *Live* (si azzera quando si riavvia l'app). Il pulsante con le onde nei controlli del player mostra o nasconde le note. Con **due microfoni** collegati al PC (due microfoni USB o due schede audio) le voci diventano due, rosa e azzurra, ognuna col suo punteggio: il microfono predefinito di Windows è di chi ha prenotato, l'altro è il «Microfono 2» (webcam e microfoni integrati del portatile vengono ignorati). Con due microfoni nello stesso mixer le voci arrivano mescolate e si vede una sola intonazione. Per sentire il microfono nelle casse si usa l'opzione di Windows «Ascolta questo dispositivo».

**Tonalità** (modalità Karaoke): nei controlli del player *Tonalità* − / + abbassa o alza la base (e la voce guida) di un semitono alla volta, fino a ±6, senza cambiare la velocità: resta a tempo con video e testo. Ogni brano parte nella tonalità originale. La versione trasposta si prepara con ffmpeg (filtro *rubberband*) la prima volta in circa 10 secondi, mentre il brano continua a suonare, e poi resta salvata nella cartella `keys` del brano. Le barre dell'intonazione restano quelle del brano: la voce di chi canta viene riportata alla tonalità originale prima del confronto, quindi il punteggio resta giusto.

Negli ultimi 30 secondi di un brano compare l'annuncio **«Sta per iniziare…»** con conto alla rovescia, e allo zero parte il cantante successivo.

**Modalità della serata** (si sceglie nella barra laterale dell'app sul PC o nei controlli del player, oppure da un amministratore dal telefono, scheda *Live*; si può cambiare anche a brano in corso: tornando in Karaoke la voce guida riparte da 0):

- **Karaoke**: si canta a turno, un brano in coda per persona, voce guida regolabile, applausi e avviso «Fra poco tocca a te». Ogni applauso dal telefono fa salire una bolla sulla TV e fa sentire l'effetto `media/sounds/applause.mp3`: gli applausi di più persone si sovrappongono, quindi più gente applaude e più l'applauso è pieno (un applauso alla volta per persona: i tocchi in più mentre la sua bolla sta salendo vengono ignorati).
- **Jukebox**: si ascolta il videoclip con la voce originale e senza testo in sovraimpressione, ognuno aggiunge quanti brani vuole (e può togliere i propri); i brani si mixano in battuta come in modalità DJ (vedi sotto); al posto di «canta» compare «Brano aggiunto da…», niente applausi né avviso del turno, l'amministratore regola solo il volume generale.
- **DJ**: come il Jukebox, ma la playlist la decide il **DJ della serata**, eletto dal PC (menu sotto Karaoke/Jukebox/DJ) o da un amministratore (*Settaggi* → *Modalità della serata*) tra i partecipanti collegati: al DJ eletto compare un avviso con il giradischi e nel *Live* «Sei il DJ della serata!» (gli altri vedono «<nome> è il DJ della serata!»). Il DJ, gli amministratori e il PC aggiungono brani senza limiti; il DJ può anche spostarli e toglierli. I brani aggiunti dagli altri utenti diventano **richieste** (una alla volta per utente) che il DJ accetta o rifiuta dalla scheda *Richieste* o dal *Live*: se la accetta, solo chi l'ha chiesta riceve «<DJ> ha accettato la tua richiesta!» con il tempo d'attesa; se la rifiuta, nessun avviso. In questa modalità gli altri utenti non ricevono avvisi sui brani aggiunti. I brani si **mixano in battuta** (anche in Jukebox), come farebbe un DJ: il brano successivo si carica in anticipo e parte esattamente sul primo tempo di una battuta di quello che finisce, 4 battute prima della fine del suo ritmo, con la velocità adattata perché i BPM coincidano (come il pitch di un giradischi, al massimo ±6%, cambia leggermente anche l'intonazione; valgono anche i tempi doppi o dimezzati). Durante il mix il nuovo entra senza bassi e sale di volume, a metà i bassi si scambiano e il vecchio sfuma a zero; sulla TV il video nuovo compare in dissolvenza. Finito il mix il brano torna piano piano (20 s) alla sua velocità originale. Se i BPM sono troppo diversi o il ritmo di uno dei due non è regolare (ballate, intro libere) si fa una dissolvenza incrociata di 10 secondi. In entrambi i casi i lunghi silenzi all'inizio del brano che entra e alla fine di quello che esce non contano: il nuovo parte da dove si sente davvero (base e voce insieme, quindi un'intro a cappella resta) e il vecchio si mixa prima del suo silenzio finale. L'annuncio «Sta per iniziare» conta fino all'inizio del mix.

## Configurazione (variabili d'ambiente)

| Variabile | Default | Note |
|---|---|---|
| `SINGITNOW_PORT` | `8765` | |
| `SINGITNOW_DATA` | `./data` | libreria, modelli, log |
| `SINGITNOW_SEPARATION_MODEL` | `UVR-MDX-NET-Inst_HQ_3.onnx` | es. `model_bs_roformer_ep_317_sdr_12.9755.ckpt` (qualità più alta, molto più lento su CPU) |
| `SINGITNOW_GPU` | `1` | `0` disattiva la scheda video per la separazione voce (si usa solo la CPU) |
| `SINGITNOW_WHISPER_MODEL` | `small` | `base` più veloce, `medium` più preciso |
| `SINGITNOW_ADMIN_PASSWORD` | *(predefinita)* | password per l'interruttore **ADMIN** del telefono; nel codice c'è solo la sua impronta SHA-256. Si cambia anche dal PC (*Settaggi*, l'ingranaggio accanto al logo → *Password amministratore*) o dai *Settaggi* di un amministratore sul telefono, inserendo quella attuale: la nuova resta in `data/admin_password.json` come impronta con sale; se la variabile è impostata ha la precedenza e dal PC non si può cambiare |

## Sviluppo

```powershell
.venv\Scripts\python -m singitnow --server   # backend su :8765
cd frontend; npm run dev                     # interfaccia con hot reload su :5173 (/ e /remote.html)
```

Test automatici (coda, duetti, competizione, testi, password; usano una cartella dati temporanea, non toccano `data/`):

```powershell
python -m uv pip install --python .venv\Scripts\python.exe -r requirements-dev.txt
.venv\Scripts\python -m pytest
```

Struttura:

```
singitnow/          backend Python (FastAPI)
  app.py            API REST + WebSocket + file statici
  pipeline.py       download → separazione → testo (worker in background)
  youtube.py        ricerca e download (yt-dlp)
  audio.py          ffmpeg + separazione voce (audio-separator)
  lyrics.py         LRCLIB + Whisper + allineamento parole
  pitch.py          note della melodia per l'intonazione
  beats.py          griglia del ritmo per il mix in battuta (modalità DJ)
  library.py        libreria su disco (data/library/<id>/)
  playlist.py       coda dei cantanti
tests/              test automatici (pytest)
android/            app Android (WebView a tutto schermo)
frontend/           React + TypeScript (Vite)
  src/desktop/      app per PC/TV (libreria, ricerca, player)
  src/remote/       app per i telefoni (PWA)
  src/shared/       API, stato in tempo reale, motore audio
```

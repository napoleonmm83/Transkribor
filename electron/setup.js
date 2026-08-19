'use strict'
/**
 * Erstinstallation der Python-Seite — das, was bisher im README stand und von Hand lief.
 *
 * Der Installer bringt Electron mit (~100 MB); die ML-Seite (torch cu128, Whisper, pyannote)
 * sind mehrere Gigabyte und kommen deshalb beim ersten Start dazu, sichtbar und abbrechbar,
 * statt den Download in ein 5-GB-Setup zu packen, das jeder Nutzer bei jedem Update erneut zieht.
 *
 * Fehlt Python oder ffmpeg, installieren wir sie ueber winget: das ist auf Windows 11 vorhanden
 * und die einzige Variante, die ohne Adminrechte und ohne eigenen Downloader auskommt.
 */
const { spawn } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const P = require('./paths')

const TORCH_INDEX = 'https://download.pytorch.org/whl/cu128'
const MIN_PY = [3, 10]

/**
 * Suchpfade, die eine aus dem Finder gestartete .app NICHT erbt: Homebrew (Apple Silicon,
 * dann Intel) und das Nutzer-bin, in dem CLI-Werkzeuge wie `claude` ueblicherweise landen.
 */
function macPfade() {
  return ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin')]
}

/**
 * Umgebung fuer jeden spawn — auch fuer den uvicorn-Start in backend.js. Eine aus dem Finder
 * gestartete .app erbt launchds PATH (/usr/bin:/bin:/usr/sbin:/sbin), nicht den der Shell:
 * per brew installiertes Python, ffmpeg und claude sind im Terminal da und fuer die App
 * unsichtbar. VORangestellt, nicht angehaengt — sonst gewinnt /usr/bin/python3 (macOS liefert
 * 3.9, von MIN_PY abgelehnt) gegen brews Python.
 *
 * Wir biegen bewusst NICHT process.env.PATH global um: das veraenderte auch alles andere, was
 * die App startet. Die Umgebung pro spawn zu bauen haelt die Aenderung dort, wo sie hingehoert.
 * Dieselbe Lektion wie POSIX_FFMPEG_DIRS in transcribe.py, nur eine Schicht frueher.
 */
function spawnEnv() {
  if (process.platform !== 'darwin') return process.env
  return { ...process.env, PATH: macPfade().join(':') + ':' + (process.env.PATH || '') }
}

const LINUX_PAKETE = {
  apt: 'sudo apt install python3 python3-venv ffmpeg',
  dnf: 'sudo dnf install python3 ffmpeg',
  pacman: 'sudo pacman -S python ffmpeg',
}

/** Der Einzeiler von brew.sh — der einzige Schritt auf macOS, den die App nicht abnehmen
 *  kann: Homebrew legt /opt/homebrew an und fragt dabei nach dem Administratorkennwort. */
const BREW_INSTALL =
  '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'

/**
 * Was auf dieser Plattform zu tun ist — reine Funktion, damit die Entscheidung ohne
 * laufendes Electron pruefbar ist.
 *
 * **macOS installiert die App selbst, sobald Homebrew da ist.** Frueher zeigte sie hier nur
 * den Befehl zum Kopieren, mit der Begruendung „braeuchte sudo“. Das stimmt fuer Homebrew
 * SELBST (es legt /opt/homebrew an) — aber nicht fuer `brew install <paket>`: der Ordner
 * gehoert danach dem Nutzer, und brew verlangt dort kein Kennwort. Die beiden Faelle waren
 * vermischt, und der Nutzer tippte einen Befehl ab, den die App genauso gut ausfuehren kann.
 * Ohne Homebrew bleibt es beim Hinweis — dann aber inklusive der Zeile, die Homebrew
 * ueberhaupt erst installiert (vorher stand dort ein `brew install …`, das ohne brew mit
 * „command not found“ endet).
 *
 * Linux bleibt beim Hinweis: `apt`/`dnf`/`pacman` brauchen echtes sudo.
 *
 * torch: macOS bekommt das normale PyPI-Rad — es bringt MPS mit, ein CUDA-Index
 * existiert dort gar nicht. Linux zieht cu128 ohne vorherige NVIDIA-Erkennung: die
 * Raeder installieren auch ohne Karte und fallen zur Laufzeit auf CPU zurueck.
 */
function plan(platform, paketmanager, arch = process.arch, brew = false) {
  if (platform === 'win32') {
    return { torchIndex: TORCH_INDEX, autoInstall: true, installer: 'winget', hinweis: '' }
  }
  if (platform === 'darwin') {
    // whisper-cpp ist die ASR-Engine auf Apple Silicon (gemessen 5.29x statt 0.81x realtime,
    // siehe webtool/whispercpp.py). Fehlt es, laeuft die Transkription weiter — nur langsam
    // ueber faster-whisper auf der CPU. NUR auf arm64: webtool/device.py:asr_engine prueft
    // die Architektur, ein Intel-Mac bekommt dort immer faster-whisper; ihn trotzdem
    // `brew install whisper-cpp` tippen zu lassen waere ein Rat, der nichts bewirkt.
    const pakete = arch === 'arm64' ? ['python', 'ffmpeg', 'whisper-cpp'] : ['python', 'ffmpeg']
    if (brew) {
      return { torchIndex: null, autoInstall: true, installer: 'brew', brewPakete: pakete, hinweis: '' }
    }
    return {
      torchIndex: null,
      autoInstall: false,
      installer: null,
      brewPakete: pakete,
      hinweis: `Bitte einmalig Homebrew installieren:  ${BREW_INSTALL}\n`
        + 'Danach „Erneut versuchen“ — den Rest erledigt Transkribor selbst.',
    }
  }
  const befehl = LINUX_PAKETE[paketmanager]
    || 'Bitte python3 (>= 3.10), python3-venv und ffmpeg ueber die Paketverwaltung installieren.'
  return {
    torchIndex: TORCH_INDEX, autoInstall: false, installer: null,
    hinweis: `Bitte einmalig installieren:  ${befehl}`,
  }
}

/** Liegt Homebrew auf dieser Maschine? Nur auf macOS gefragt — `ausgabe` sucht ueber
 *  spawnEnv() auch in /opt/homebrew/bin, das eine aus dem Finder gestartete .app nicht erbt. */
async function brewDa() {
  if (process.platform !== 'darwin') return false
  return !!(await ausgabe('brew', ['--version']))
}

/** Welcher Paketmanager liegt auf diesem Linux? Leerstring, wenn keiner erkannt wird. */
async function paketmanager() {
  if (process.platform !== 'linux') return ''
  for (const p of ['apt', 'dnf', 'pacman']) {
    if (await ausgabe('which', [p])) return p
  }
  return ''
}

/** Kommando ausfuehren und jede Zeile melden. Loest mit dem Exitcode auf, wirft nie. */
function lauf(cmd, args, onLine, opts = {}) {
  return new Promise(resolve => {
    // Abbruch VOR dem Start: ein Merker aus der Zeit eines kurzen Sondierungs-Schritts
    // darf nicht noch einen neuen Prozess aufmachen (#242).
    if (abbruchFlag) return resolve(-1)
    onLine(`> ${cmd} ${args.join(' ')}`)
    let proc
    try {
      proc = spawn(cmd, args, { windowsHide: true, env: spawnEnv(), ...opts })
    } catch (e) {
      onLine(`FEHLER: ${e.message}`)
      return resolve(-1)
    }
    laufenderSchritt = proc
    const rest = { out: '', err: '' }
    const pump = (k, buf) => {
      rest[k] += buf.toString()
      const zeilen = rest[k].split(/\r?\n/)
      rest[k] = zeilen.pop()
      zeilen.filter(z => z.trim()).forEach(onLine)
    }
    proc.stdout.on('data', b => pump('out', b))
    proc.stderr.on('data', b => pump('err', b))
    proc.on('error', e => {
      laufenderSchritt = null
      onLine(`FEHLER: ${e.message}`)
      resolve(-1)
    })
    proc.on('close', code => {
      laufenderSchritt = null
      if (rest.out.trim()) onLine(rest.out.trim())
      if (rest.err.trim()) onLine(rest.err.trim())
      resolve(code === null ? -1 : code)
    })
  })
}

/** Ergebnis eines abgebrochenen Laufs. Eigener Schluessel `abgebrochen`, damit die Seite
 *  einen GEWOLLTEN Abbruch nicht als roten Installationsfehler zeigt (#242). */
const ABBRUCH = Object.freeze({ ok: false, abgebrochen: true,
  fehler: 'Abgebrochen. Die Einrichtung wird beim nächsten Start wieder angeboten.' })

/** Abbruch-Zustand (#242): der Knopf ist einen Tastendruck von 10–30 Minuten entfernt,
 *  und der Lauf war der einzige der App ohne Rückweg (jobs.py kann längst abbrechen).
 *  Einmal gesetzt, bricht der Merker JEDEM weiteren Schritt den Hals — auch einem, der
 *  erst nach einer kurzen Sondierung starten wollte. */
let abbruchFlag = false
let laufenderSchritt = null

/** Vom Hauptprozess gerufen (IPC 'einrichten:abbrechen'). `toeter` ist der Testzugang. */
function abbrechen(toeter = _baumToeten) {
  abbruchFlag = true
  if (laufenderSchritt) toeter(laufenderSchritt)
}

/** Prozessbaum toeten — /T wie jobs.py: ein Waisenkind hielte Dateien der venv offen und
 *  sieht danach "halbe Installation" aus, gegen die #181/#217 gebaut wurden. */
function _baumToeten(proc) {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true })
  } else {
    try { proc.kill('SIGTERM') } catch { /* bereits tot */ }
  }
}

/**
 * ffmpeg im winget-Paketverzeichnis suchen. Gyan.FFmpeg legt KEINEN Link in WinGet\Links —
 * es steht also nach der Installation trotzdem nie auf dem PATH. `where ffmpeg` meldete es
 * darum dauerhaft als fehlend, obwohl transcribe.ensure_ffmpeg() dieselbe Datei laengst
 * benutzt: die Statusseite log jeden Windows-Nutzer an, und einrichten() liess winget bei
 * JEDEM Lauf neu installieren.
 *
 * `wurzel` ist Parameter, damit die Suche ohne echtes winget pruefbar ist — wie plan().
 */
function wingetFfmpeg(wurzel = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages')) {
  const lies = d => { try { return fs.readdirSync(d) } catch { return [] } }
  for (const paket of lies(wurzel).filter(n => n.startsWith('Gyan.FFmpeg'))) {
    for (const bau of lies(path.join(wurzel, paket)).filter(n => n.startsWith('ffmpeg'))) {
      const exe = path.join(wurzel, paket, bau, 'bin', 'ffmpeg.exe')
      if (fs.existsSync(exe)) return exe
    }
  }
  return ''
}

/**
 * Der eine Ort, an dem gefragt wird "gibt es ffmpeg?" — sonst driften Statusanzeige und
 * Einrichtung auseinander. macOS/Linux braucht keinen Sonderweg: ausgabe() spawnt mit
 * spawnEnv(), das die brew-Pfade voranstellt.
 */
async function findeFfmpeg() {
  const auf = await ausgabe(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'])
  if (auf) return auf.split(/\r?\n/)[0].trim()
  return process.platform === 'win32' ? wingetFfmpeg() : ''
}

function ausgabe(cmd, args) {
  return new Promise(resolve => {
    let proc
    try { proc = spawn(cmd, args, { windowsHide: true, env: spawnEnv() }) } catch { return resolve(null) }
    let s = ''
    proc.stdout.on('data', b => { s += b })
    proc.stderr.on('data', b => { s += b })          // `python --version` schrieb frueher nach stderr
    proc.on('error', () => resolve(null))
    proc.on('close', code => resolve(code === 0 ? s.trim() : null))
  })
}

/** Erstes brauchbares System-Python. `py -3` zuerst: der Launcher findet auch Installationen, die nicht im PATH stehen. */
async function findePython() {
  const kandidaten = process.platform === 'win32'
    ? [['py', ['-3', '--version']], ['python', ['--version']], ['python3', ['--version']]]
    : [['python3', ['--version']], ['python', ['--version']]]
  for (const [cmd, args] of kandidaten) {
    const v = await ausgabe(cmd, args)
    const m = v && v.match(/(\d+)\.(\d+)/)
    if (!m) continue
    const [maj, min] = [+m[1], +m[2]]
    if (maj > MIN_PY[0] || (maj === MIN_PY[0] && min >= MIN_PY[1])) {
      return { cmd, args: args.slice(0, -1), version: `${maj}.${min}` }
    }
  }
  return null
}

/** Die venv gilt erst als fertig, wenn sie wirklich importierbar ist — ein abgebrochener
 *  pip-Lauf hinterlaesst sonst eine halbe Umgebung, die beim naechsten Start "da" aussieht. */
async function importeDa() {
  const py = P.venvPython(P.venv)
  if (!P.exists(py)) return false
  // faster_whisper statt whisper: seit dem Engine-Wechsel ist openai-whisper nicht mehr
  // installiert — die alte Zeile haette JEDE fertige venv als unvollstaendig gemeldet und
  // bei jedem Start eine Neuinstallation ausgeloest.
  const r = await ausgabe(py, ['-c', 'import torch, faster_whisper, fastapi, uvicorn; print("ok")'])
  return r !== null && r.includes('ok')
}

/** Pfad des Merkers: gegen welchen Stand der requirements.txt wurde zuletzt installiert.
 *  IN der venv, nicht daneben — wer sie wegwirft, wirft den Merker mit weg. */
function stempel(venvDir = P.venv) { return path.join(venvDir, '.requirements') }

/**
 * Leerstring heisst "keine lesbare requirements.txt" — dann gibt es nichts nachzuziehen.
 * `reqDatei` ist der Testzugang: ohne ihn liesse sich nicht pruefen, dass der Merker
 * ueberhaupt AN DIESER DATEI haengt (ein Test, der nur den Merker verbiegt, belegt das nicht).
 *
 * Gehasht wird der INHALT, nicht die Bytes (#229): Kommentare, Leerzeilen, Zeilenenden und
 * die Reihenfolge gehen nicht mit ein. Die Datei besteht zu grob zwei Dritteln aus Prosa —
 * drei der letzten vier Commits, die sie beruehrt haben, haben ausschliesslich
 * Kommentarbloecke umgeschrieben. Roh gehasht erklaert jede solche Aenderung bei JEDEM
 * Nutzer die venv fuer veraltet und kostet ihn eine Einrichtungsrunde, die inhaltlich nichts
 * tut; dasselbe gilt fuer einen Checkout, dessen core.autocrlf die Datei umschreibt.
 * Harmlos im Einzelfall (ein Klick) — nur nutzt es genau die Aufmerksamkeit ab, auf die #181
 * baut: wer die Seite dreimal grundlos gesehen hat, liest sie beim vierten Mal nicht mehr.
 *
 * **`(^|\s)#` schneidet, nicht blosses `#`** — dieselbe Regel wie pips Parser: ein Kommentar
 * beginnt am Zeilenanfang oder nach Leerraum. Mit blossem `#` faellt auch ein URL-Fragment
 * weg, und dann normalisieren `…/torch.whl#sha256=aaa` und `…#sha256=bbb` auf **denselben**
 * Hash: zwei verschiedene Paketstaende, ein Merker, „aktuell" — die Einrichtung wird nicht
 * angeboten und das neue Pin erreicht den Nutzer nie. Der rohe Byte-Hash konnte das nicht;
 * es waere also genau der Schaden, gegen den #181 gebaut ist, neu aufgemacht von seiner
 * eigenen Reparatur. Heute steht kein solches Fragment in der Datei — der Vorbehalt haette
 * an einer Aufmerksamkeit gehangen, die in sechs Monaten niemand hat, und kostet so ein
 * Zeichenpaar.
 */
function reqHash(reqDatei = P.requirements) {
  try {
    const zeilen = fs.readFileSync(reqDatei, 'utf8')
      .split(/\r?\n/).map(z => z.replace(/(^|\s)#.*/, '').trim()).filter(Boolean).sort()
    return crypto.createHash('sha256').update(zeilen.join('\n')).digest('hex')
  } catch { return '' }
}

/**
 * Entspricht die venv der heutigen requirements.txt?
 *
 * `pip install -r` laeuft in der installierten App genau einmal — beim ersten Start. Danach
 * ersetzt ein App-Update die .exe, aber nicht die venv (die liegt in userData und ueberlebt
 * bewusst). Ohne diesen Vergleich erreicht JEDES Paket, das nach dem Installationstag eines
 * Nutzers dazukommt, ihn nie: die Funktion fehlt still, die App sieht gesund aus (#181).
 * Bisher bekam jeder Fall einen eigenen Weg (yt-dlp: webtool/ytdlp_update.py, yt-dlp-ejs:
 * `_ejs_untauglich`) — das ist der eine Weg fuer alle. Sie bleiben trotzdem noetig: dieser
 * hier greift nur in der gepackten App und nur, wenn der Nutzer klickt.
 *
 * Fehlender Merker gilt als veraltet: JEDE heute bestehende Installation ist es auch.
 * Was er NICHT weiss: ob die Pakete noch da sind. Er sagt "gegen diese Datei installiert",
 * nicht "diese Pakete liegen vor" — ein von Hand entferntes Paket faellt ihm nicht auf.
 */
function paketeAktuell(venvDir = P.venv, reqDatei = P.requirements) {
  const soll = reqHash(reqDatei)
  if (!soll) return true
  try { return fs.readFileSync(stempel(venvDir), 'utf8').trim() === soll } catch { return false }
}

/**
 * Laesst sich der Merker hier ueberhaupt schreiben? Gefragt wird das NUR, wenn die venv als
 * veraltet gilt — also genau dann, wenn die Einrichtungsseite erscheint (#230).
 *
 * Ohne diese Auskunft ist ein nicht schreibbarer Merker eine Endlosschleife ohne Grund: die
 * Seite erscheint bei JEDEM Start, ein Klick laeuft jedes Mal erfolgreich durch und aendert
 * nichts an der Wiederkehr. Sichtbar stand der Zustand nirgends — es gibt genau einen
 * onLine-Hinweis, und der landet im zugeklappten Protokollbereich, waehrend die Seite selbst
 * weiter dieselbe Aussage wiederholt, die der Nutzer gerade abgearbeitet hat.
 *
 * **Angehaengt wird NICHTS** — und das ist der ganze Trick. `fs.accessSync(p, W_OK)` stand hier
 * zuerst und beantwortet die falsche Frage: es fragt Metadaten ab, **oeffnet die Datei aber
 * nicht**. Ein Virenscanner (oder irgendein anderer Prozess), der sie mit exklusivem Handle
 * festhaelt, ist davon nicht zu unterscheiden — die Sperre entsteht erst beim Oeffnen, das dort
 * nie stattfindet; auf Windows wertet `access()` ausserdem laut Node-Doku keine ACLs aus.
 * Nachgemessen (Windows, Wegwerf-Ordner): `appendFileSync(p, '')` wirft auf einer 444-Datei
 * EPERM und laesst den Inhalt unveraeendert.
 *
 * Damit faellt auch der zweite Zweig weg: fehlt die Datei, legt das Anhaengen eine **leere** an
 * — und die liest `paketeAktuell()` genauso als „veraltet" wie gar keine (`''` !== Hash).
 * Fehlt das Verzeichnis, wirft es ENOENT.
 *
 * **Kein Ersatz waere `stempelSchreiben()`:** das schriebe den heutigen Hash und erklaerte
 * damit eine venv fuer fertig, der Pakete fehlen.
 *
 * Was er nicht sieht: eine **volle Platte** (null Bytes brauchen keinen Platz) und eine Datei,
 * die erst zwischen Probe und Schreibversuch gesperrt wird. Deshalb nennt weder die Seite noch
 * die README eine Ursachenliste — nur die Datei.
 */
function stempelSchreibbar(venvDir = P.venv) {
  try { fs.appendFileSync(stempel(venvDir), ''); return true } catch { return false }
}

/** Nach erfolgreichem `pip install -r`. Wirft nicht: ein misslungener Merker darf den Start
 *  nicht verhindern — er kostet hoechstens einen zweiten Einrichtungslauf. */
function stempelSchreiben(venvDir = P.venv, reqDatei = P.requirements) {
  const soll = reqHash(reqDatei)
  if (!soll) return false
  try { fs.writeFileSync(stempel(venvDir), soll); return true } catch { return false }
}

/**
 * Die zwei Haelften zu dem, was die Oberflaeche braucht — als reine Funktion, weil hier die
 * Entscheidung faellt, die main.js liest (`if (s.venv) serverStarten()`). Stuende sie nur
 * inline in status(), waere genau der Riegel ungetestet: `venv: importe` allein liesse einen
 * veralteten Stand durch, und keine Attrappe der Welt merkt das.
 */
function venvZustand(importe, aktuell) {
  return { venv: importe && aktuell, venvVeraltet: importe && !aktuell }
}

/** Nutzt diese Maschine ueberhaupt whisper.cpp? Spiegelt device.apple_silicon() —
 *  auf einem Intel-Mac rechnet immer faster-whisper, dort gibt es nichts zu melden. */
function nutztWhisperCpp(platform = process.platform, arch = process.arch) {
  return platform === 'darwin' && arch === 'arm64'
}

/**
 * whisper-cli (Homebrew-Paket whisper-cpp) — die ASR-Engine auf Apple Silicon.
 * Leerstring heisst nicht "kaputt": ohne sie faellt webtool/device.py auf
 * faster-whisper zurueck, die Transkription laeuft weiter, nur langsam.
 */
async function findeWhisperCpp() {
  if (!nutztWhisperCpp()) return ''
  const auf = await ausgabe('which', ['whisper-cli'])
  return auf ? auf.split(/\r?\n/)[0].trim() : ''
}

async function status() {
  const py = await findePython()
  const ff = await findeFfmpeg()
  const wcpp = await findeWhisperCpp()
  const pl = plan(process.platform, await paketmanager(), process.arch, await brewDa())
  const macFehlt = nutztWhisperCpp() && !wcpp
  const importe = await importeDa()
  const aktuell = paketeAktuell()
  // Beide Haelften einzeln, damit die Seite den Unterschied nennen kann: eine veraltete venv
  // ist installiert und funktioniert — sie ist nur nicht auf dem Stand der requirements.txt.
  // Als blosses rotes "fehlt" gemeldet, laese der Nutzer einen Defekt daraus (#181).
  return {
    python: py ? `Python ${py.version}` : '',
    ffmpeg: ff,
    whispercpp: wcpp,
    ...venvZustand(importe, aktuell),
    stempelPfad: stempel(P.venv),
    // Nur im degradierten Fall gefragt (#230): sonst kostet jeder Start zwei Systemaufrufe
    // fuer eine Auskunft, die niemand sieht. `true` heisst hier "kein Grund zur Meldung" —
    // die Seite erscheint dann ohnehin nicht.
    stempelSchreibbar: (importe && !aktuell) ? stempelSchreibbar() : true,
    winget: process.platform === 'win32' ? (await ausgabe('winget', ['--version'])) || '' : '',
    venvPfad: P.venv,
    projektePfad: P.projekte,
    // Nicht leer heisst: hier installiert die App nichts selbst (macOS/Linux), der Nutzer
    // braucht den Befehl. Auf Windows bleibt es leer — winget uebernimmt.
    // whisper-cpp zaehlt mit: es fehlt sonst still, und der Nutzer wartet das Sechsfache,
    // ohne zu erfahren, dass ein `brew install` das behebt.
    hinweis: (py && ff && !macFehlt) ? '' : pl.hinweis,
  }
}

/**
 * Hat der `-r`-Lauf torch gegen ein Rad vom Standardindex getauscht? Auf Windows/Linux ist das
 * das CPU-Rad, und die GPU waere STILL weg — genau der Tausch, wegen dem torch bewusst NICHT in
 * der requirements.txt steht.
 *
 * Erreichbar ist er erst, seit die Einrichtung nachlaeuft (#181): frueher folgte `-r` immer
 * unmittelbar auf eine frische torch-Installation, die Untergrenze war also nie zu heben. Jetzt
 * trifft `-r` ein Monate altes torch — zieht eine Abhaengigkeit ihre Grenze an (pyannote.audio
 * verlangt heute torch>=2.8.0), holt pip die Ersatzfassung dort, wo sie steht: bei PyPI.
 *
 * Die Marke im print ist noetig, weil `ausgabe` stderr mitliest — eine Warnung beim Import
 * machte einen blossen Leerstring-Vergleich blind. Keine verwertbare Antwort heisst NICHTS tun:
 * die Pruefung danach meldet eine kaputte venv ohnehin, und ein mehrere GB grosser Download
 * auf ein unklares Signal hin waere teuer geraten.
 */
function cudaVerloren(pl, antwort) {
  // Ohne CUDA-Index (macOS) gibt es nichts zurueckzuholen — dort ist `torch.version.cuda`
  // IMMER leer, ein Nachlauf zoege das PyPI-Rad ein zweites Mal.
  if (!pl.torchIndex) return false
  const treffer = (antwort || '').match(/CUDA=(\S*)/)
  return !!treffer && !treffer[1]
}

// `werkzeug` wird hereingereicht wie `hole`/`openExternal` in updater.js — sonst liesse sich
// der Fehlschlag nur mit einem echten, kaputten pip-Lauf pruefen, und genau der Zweig traegt
// die Meldung, an der der Nutzer den Verlust ueberhaupt bemerkt.
async function cudaZurueckholen(vpy, pl, onLine, werkzeug = { ausgabe, lauf }) {
  const antwort = await werkzeug.ausgabe(vpy, ['-c', 'import torch; print("CUDA=" + (torch.version.cuda or ""))'])
  if (!cudaVerloren(pl, antwort)) return true
  onLine('torch hat seine CUDA-Fassung verloren — hole sie zurueck (sonst rechnet alles auf der CPU).')
  const code = await werkzeug.lauf(vpy, ['-m', 'pip', 'install', '-U', 'torch', '--index-url', pl.torchIndex], onLine)
  // Scheitert das Zurueckholen, laeuft die App auf der CPU weiter — dieselbe Linie wie der
  // CPU-Rueckfall im torch-Schritt und wie whisper-cpp: langsam ist besser als gar nicht.
  // Der Merker wird trotzdem geschrieben: er sagt "gegen DIESE requirements.txt installiert",
  // und das stimmt weiterhin. Ihn hier zu verweigern gaebe ihm eine zweite Bedeutung ("und
  // torch ist gesund") — und brockte dem Nutzer bei dauerhaft unerreichbarem Index eine
  // Einrichtungsseite bei jedem Start ein, jedes Mal mit GB-Download. Sichtbar bleibt der
  // Zustand ueber die Einstellungsseite, die CPU-torch von sich aus benennt (`GET /api/hardware`).
  if (code !== 0) onLine('Zurueckholen fehlgeschlagen — die Transkription rechnet auf der CPU und ist damit deutlich langsamer. Unter „Einstellungen“ steht, wie sich das beheben laesst.')
  return code === 0
}

/**
 * Richtet alles Fehlende ein. `onLine` bekommt jede Log-Zeile, `onSchritt` den Fortschritt.
 * Gibt `{ok, fehler}` zurueck; wirft nicht, damit das Fenster den Fehler anzeigen kann.
 *
 * `werkzeug` wird hereingereicht wie bei `cudaZurueckholen` — aus demselben Grund, nur eine
 * Ebene groesser (#232): hier faellt JEDE teure Entscheidung dieser Datei — torch aus dem
 * CUDA-Index oder vom Standardindex, nach welchem Fehlschlag abgebrochen und nach welchem
 * weitergelaufen wird, ob der Merker geschrieben wird. Ohne Seam ist keine davon anders
 * pruefbar als mit einem echten, mehrere Gigabyte grossen pip-Lauf, und ein Fehler darin
 * kostet den Nutzer die GPU oder sperrt ihn aus, ohne dass ein Test murrt.
 *
 * **Teilweise Ueberschreibung** (`...werkzeug` ueber den Vorgaben): ein Test nennt die zwei
 * bis drei Schluessel, um die es ihm geht. Muesste er alle zehn stellen, stuende in jedem
 * Test eine vollstaendige Attrappe — und die naechste hinzukommende Abhaengigkeit fiele in
 * allen gleichzeitig auf die echte Funktion zurueck, weil niemand sie nachtraegt.
 *
 * `planen` fasst `paketmanager()` + `brewDa()` + `plan()` zusammen, statt drei Schluessel zu
 * kosten: `plan` ist eine reine Funktion mit eigenen Tests, gebraucht wird hier nur ihr
 * Ergebnis — und die beiden Sondierungen dahinter starten je einen echten Prozess.
 */
async function einrichten(onLine, onSchritt, werkzeug = {}) {
  const w = {
    planen: async () => plan(process.platform, await paketmanager(), process.arch, await brewDa()),
    lauf, findePython, findeFfmpeg, findeWhisperCpp, importeDa, stempelSchreiben,
    cudaZurueckholen, exists: P.exists,
    mkdir: d => fs.mkdirSync(d, { recursive: true }),
    ...werkzeug,
  }
  // Frischer Abbruch-Merker: der Knopf bleibt nach einem Abbruch erreichbar, ein
  // haengengebliebener Merker wuerde jeden Folgelauf sofort wieder toeten (#242).
  abbruchFlag = false
  const schritte = []
  let py = await w.findePython()
  const pl = await w.planen()
  /** Ein Paket ueber den Installer dieser Plattform. `null` = hier installiert die App nicht. */
  const holen = (winget, brewPaket) => {
    if (pl.installer === 'winget') {
      return w.lauf('winget', ['install', '-e', '--id', winget,
        '--accept-package-agreements', '--accept-source-agreements'], onLine)
    }
    if (pl.installer === 'brew') return w.lauf('brew', ['install', brewPaket], onLine)
    return null
  }

  if (!py && pl.installer) {
    onSchritt('Python installieren')
    onLine('Python nicht gefunden — installiere es …')
    const code = await holen('Python.Python.3.13', 'python')
    if (abbruchFlag) return ABBRUCH
    if (code !== 0) return { ok: false, fehler: 'Python konnte nicht installiert werden. Bitte von python.org installieren und Transkribor neu starten.' }
    py = await w.findePython()
    if (!py) return { ok: false, fehler: 'Python wurde installiert, ist aber noch nicht im PATH. Bitte Transkribor neu starten.' }
  }
  if (!py) return { ok: false, fehler: `Kein Python >= 3.10 gefunden. ${pl.hinweis}` }
  schritte.push(`Python: ${py.version}`)

  if (!(await w.findeFfmpeg())) {
    if (pl.installer) {
      onSchritt('ffmpeg installieren')
      onLine('ffmpeg nicht gefunden — installiere es …')
      // Nicht abbrechen wenn es scheitert: ohne ffmpeg laeuft immerhin noch das Bearbeiten
      // vorhandener Transkripte.
      await holen('Gyan.FFmpeg', 'ffmpeg')
      if (abbruchFlag) return ABBRUCH
    } else {
      onLine(`ffmpeg nicht gefunden. ${pl.hinweis}`)
    }
  }

  // whisper-cpp gibt es nur auf Apple Silicon und nur ueber brew. Es fehlt sonst STILL —
  // die Transkription laeuft dann sechsmal langsamer, ohne dass jemand den Grund erfaehrt.
  // Kein Abbruch bei Fehlschlag: langsam ist besser als gar nicht.
  if (pl.installer === 'brew' && pl.brewPakete.includes('whisper-cpp') && !(await w.findeWhisperCpp())) {
    onSchritt('Schnelle Spracherkennung (whisper-cpp) installieren')
    await w.lauf('brew', ['install', 'whisper-cpp'], onLine)
    if (abbruchFlag) return ABBRUCH
  }

  if (!w.exists(P.venvPython(P.venv))) {
    onSchritt('Umgebung anlegen')
    w.mkdir(path.dirname(P.venv))
    const code = await w.lauf(py.cmd, [...py.args, '-m', 'venv', P.venv], onLine)
    if (abbruchFlag) return ABBRUCH
    if (code !== 0) return { ok: false, fehler: 'venv konnte nicht angelegt werden.' }
  }
  const vpy = P.venvPython(P.venv)

  onSchritt('pip aktualisieren')
  await w.lauf(vpy, ['-m', 'pip', 'install', '-U', 'pip'], onLine)
  if (abbruchFlag) return ABBRUCH

  onSchritt(pl.torchIndex ? 'PyTorch mit CUDA laden (mehrere GB, dauert)'
                          : 'PyTorch laden (mehrere GB, dauert)')
  const torchArgs = ['-m', 'pip', 'install', 'torch']
  if (pl.torchIndex) torchArgs.push('--index-url', pl.torchIndex)
  let code = await w.lauf(vpy, torchArgs, onLine)
  if (abbruchFlag) return ABBRUCH
  if (code !== 0 && pl.torchIndex) {
    onLine('CUDA-Variante fehlgeschlagen — versuche die CPU-Variante (Transkription wird dann langsam).')
    code = await w.lauf(vpy, ['-m', 'pip', 'install', 'torch'], onLine)
  }
  if (abbruchFlag) return ABBRUCH
  if (code !== 0) return { ok: false, fehler: 'PyTorch konnte nicht installiert werden.' }

  onSchritt('Whisper und Werkzeuge laden')
  code = await w.lauf(vpy, ['-m', 'pip', 'install', '-r', P.requirements], onLine)
  if (abbruchFlag) return ABBRUCH
  if (code !== 0) return { ok: false, fehler: 'Python-Pakete konnten nicht installiert werden.' }
  const torchOk = await w.cudaZurueckholen(vpy, pl, onLine)
  if (abbruchFlag) return ABBRUCH

  // Geprueft wird der Import, NICHT der Merker: ein misslungenes Vermerken wuerde den Nutzer
  // sonst aussperren (kein ok -> kein Serverstart), obwohl alles installiert ist.
  onSchritt('Prüfen')
  if (!(await w.importeDa())) return { ok: false, fehler: 'Einrichtung unvollstaendig — bitte erneut versuchen.' }
  // Erst NACH der Pruefung: der Merker behauptet "fertig eingerichtet gegen diese
  // requirements.txt", und das soll er nur ueber eine venv sagen, die sich importieren laesst.
  //
  // Und NICHT nach einem gescheiterten CUDA-Nachlauf: sonst gilt die venv als fertig, die
  // Einrichtung wird nie wieder angeboten — und der Hinweis auf der Einstellungsseite
  // („PyTorch ohne CUDA installiert — dann die Umgebung neu einrichten“) zeigt auf einen Weg,
  // den es dann gar nicht mehr gibt. Ohne Merker bietet die Seite den Lauf beim naechsten Start
  // erneut an; die App startet trotzdem (ok), sie rechnet nur langsam.
  if (!torchOk) {
    onLine('Der Paketstand wird nicht vermerkt — die Einrichtungsseite bietet den Lauf beim naechsten Start erneut an.')
  } else if (!w.stempelSchreiben()) {
    // Mit PFAD (#230): ohne ihn ist die Meldung eine Feststellung, mit ihm eine Anleitung —
    // die Seite kommt beim naechsten Start wieder, und dies ist die einzige Stelle, an der
    // ueberhaupt jemand erfaehrt, an welcher Datei es liegt.
    onLine(`Hinweis: Paketstand konnte nicht vermerkt werden (${stempel(P.venv)}) — ` +
           'die Einrichtung meldet sich deshalb beim naechsten Start erneut.')
  }
  onLine('Fertig. ' + schritte.join(' · '))
  return { ok: true }
}

// venvVollstaendig() ist ersatzlos weg: status() beantwortet dieselbe Frage ueber venvZustand(),
// und ein zweiter Weg dorthin waere genau der, den kein Test bewacht (er hatte keinen Aufrufer).
module.exports = { status, einrichten, abbrechen, lauf, findePython, plan, spawnEnv, wingetFfmpeg,
                   nutztWhisperCpp, paketeAktuell, stempelSchreiben, stempelSchreibbar,
                   venvZustand, cudaVerloren, cudaZurueckholen }

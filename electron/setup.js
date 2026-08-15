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
    onLine(`> ${cmd} ${args.join(' ')}`)
    let proc
    try {
      proc = spawn(cmd, args, { windowsHide: true, env: spawnEnv(), ...opts })
    } catch (e) {
      onLine(`FEHLER: ${e.message}`)
      return resolve(-1)
    }
    const rest = { out: '', err: '' }
    const pump = (k, buf) => {
      rest[k] += buf.toString()
      const zeilen = rest[k].split(/\r?\n/)
      rest[k] = zeilen.pop()
      zeilen.filter(z => z.trim()).forEach(onLine)
    }
    proc.stdout.on('data', b => pump('out', b))
    proc.stderr.on('data', b => pump('err', b))
    proc.on('error', e => { onLine(`FEHLER: ${e.message}`); resolve(-1) })
    proc.on('close', code => {
      if (rest.out.trim()) onLine(rest.out.trim())
      if (rest.err.trim()) onLine(rest.err.trim())
      resolve(code === null ? -1 : code)
    })
  })
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

/** Leerstring heisst "keine lesbare requirements.txt" — dann gibt es nichts nachzuziehen.
 *  `reqDatei` ist der Testzugang: ohne ihn liesse sich nicht pruefen, dass der Merker
 *  ueberhaupt AN DIESER DATEI haengt (ein Test, der nur den Merker verbiegt, belegt das nicht). */
function reqHash(reqDatei = P.requirements) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(reqDatei)).digest('hex') }
  catch { return '' }
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
  // Beide Haelften einzeln, damit die Seite den Unterschied nennen kann: eine veraltete venv
  // ist installiert und funktioniert — sie ist nur nicht auf dem Stand der requirements.txt.
  // Als blosses rotes "fehlt" gemeldet, laese der Nutzer einen Defekt daraus (#181).
  return {
    python: py ? `Python ${py.version}` : '',
    ffmpeg: ff,
    whispercpp: wcpp,
    ...venvZustand(await importeDa(), paketeAktuell()),
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
 */
async function einrichten(onLine, onSchritt) {
  const schritte = []
  let py = await findePython()
  const pm = await paketmanager()
  const pl = plan(process.platform, pm, process.arch, await brewDa())
  /** Ein Paket ueber den Installer dieser Plattform. `null` = hier installiert die App nicht. */
  const holen = (winget, brewPaket) => {
    if (pl.installer === 'winget') {
      return lauf('winget', ['install', '-e', '--id', winget,
        '--accept-package-agreements', '--accept-source-agreements'], onLine)
    }
    if (pl.installer === 'brew') return lauf('brew', ['install', brewPaket], onLine)
    return null
  }

  if (!py && pl.installer) {
    onSchritt('Python installieren')
    onLine('Python nicht gefunden — installiere es …')
    const code = await holen('Python.Python.3.13', 'python')
    if (code !== 0) return { ok: false, fehler: 'Python konnte nicht installiert werden. Bitte von python.org installieren und Transkribor neu starten.' }
    py = await findePython()
    if (!py) return { ok: false, fehler: 'Python wurde installiert, ist aber noch nicht im PATH. Bitte Transkribor neu starten.' }
  }
  if (!py) return { ok: false, fehler: `Kein Python >= 3.10 gefunden. ${pl.hinweis}` }
  schritte.push(`Python: ${py.version}`)

  if (!(await findeFfmpeg())) {
    if (pl.installer) {
      onSchritt('ffmpeg installieren')
      onLine('ffmpeg nicht gefunden — installiere es …')
      // Nicht abbrechen wenn es scheitert: ohne ffmpeg laeuft immerhin noch das Bearbeiten
      // vorhandener Transkripte.
      await holen('Gyan.FFmpeg', 'ffmpeg')
    } else {
      onLine(`ffmpeg nicht gefunden. ${pl.hinweis}`)
    }
  }

  // whisper-cpp gibt es nur auf Apple Silicon und nur ueber brew. Es fehlt sonst STILL —
  // die Transkription laeuft dann sechsmal langsamer, ohne dass jemand den Grund erfaehrt.
  // Kein Abbruch bei Fehlschlag: langsam ist besser als gar nicht.
  if (pl.installer === 'brew' && pl.brewPakete.includes('whisper-cpp') && !(await findeWhisperCpp())) {
    onSchritt('Schnelle Spracherkennung (whisper-cpp) installieren')
    await lauf('brew', ['install', 'whisper-cpp'], onLine)
  }

  if (!P.exists(P.venvPython(P.venv))) {
    onSchritt('Umgebung anlegen')
    fs.mkdirSync(path.dirname(P.venv), { recursive: true })
    const code = await lauf(py.cmd, [...py.args, '-m', 'venv', P.venv], onLine)
    if (code !== 0) return { ok: false, fehler: 'venv konnte nicht angelegt werden.' }
  }
  const vpy = P.venvPython(P.venv)

  onSchritt('pip aktualisieren')
  await lauf(vpy, ['-m', 'pip', 'install', '-U', 'pip'], onLine)

  onSchritt(pl.torchIndex ? 'PyTorch mit CUDA laden (mehrere GB, dauert)'
                          : 'PyTorch laden (mehrere GB, dauert)')
  const torchArgs = ['-m', 'pip', 'install', 'torch']
  if (pl.torchIndex) torchArgs.push('--index-url', pl.torchIndex)
  let code = await lauf(vpy, torchArgs, onLine)
  if (code !== 0 && pl.torchIndex) {
    onLine('CUDA-Variante fehlgeschlagen — versuche die CPU-Variante (Transkription wird dann langsam).')
    code = await lauf(vpy, ['-m', 'pip', 'install', 'torch'], onLine)
  }
  if (code !== 0) return { ok: false, fehler: 'PyTorch konnte nicht installiert werden.' }

  onSchritt('Whisper und Werkzeuge laden')
  code = await lauf(vpy, ['-m', 'pip', 'install', '-r', P.requirements], onLine)
  if (code !== 0) return { ok: false, fehler: 'Python-Pakete konnten nicht installiert werden.' }
  const torchOk = await cudaZurueckholen(vpy, pl, onLine)

  // Geprueft wird der Import, NICHT der Merker: ein misslungenes Vermerken wuerde den Nutzer
  // sonst aussperren (kein ok -> kein Serverstart), obwohl alles installiert ist.
  onSchritt('Prüfen')
  if (!(await importeDa())) return { ok: false, fehler: 'Einrichtung unvollstaendig — bitte erneut versuchen.' }
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
  } else if (!stempelSchreiben()) {
    onLine('Hinweis: Paketstand konnte nicht vermerkt werden — die Einrichtung meldet sich beim naechsten Start erneut.')
  }
  onLine('Fertig. ' + schritte.join(' · '))
  return { ok: true }
}

// venvVollstaendig() ist ersatzlos weg: status() beantwortet dieselbe Frage ueber venvZustand(),
// und ein zweiter Weg dorthin waere genau der, den kein Test bewacht (er hatte keinen Aufrufer).
module.exports = { status, einrichten, findePython, plan, spawnEnv, wingetFfmpeg,
                   nutztWhisperCpp, paketeAktuell, stempelSchreiben, venvZustand, cudaVerloren,
                   cudaZurueckholen }

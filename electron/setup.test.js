'use strict'
const Module = require('node:module')
const echt = Module._load
Module._load = (req, ...rest) =>
  req === 'electron' ? { app: { isPackaged: false, getPath: () => '/tmp' } } : echt(req, ...rest)

const test = require('node:test')
const assert = require('node:assert')
const { plan, spawnEnv, wingetFfmpeg } = require('./setup')

/** process.platform ist read-only — fuer den Test kurz umbiegen und sicher zuruecksetzen. */
function aufPlattform(p, fn) {
  const echt = process.platform
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
  try { return fn() } finally {
    Object.defineProperty(process, 'platform', { value: echt, configurable: true })
  }
}

test('Windows: winget automatisch, torch aus dem CUDA-Index', () => {
  const p = plan('win32', '')
  assert.strictEqual(p.autoInstall, true)
  assert.match(p.torchIndex, /cu128/)
})

test('macOS OHNE Homebrew: kein Automatismus, torch vom PyPI-Standardrad (bringt MPS mit)', () => {
  const p = plan('darwin', '', 'arm64', false)
  assert.strictEqual(p.autoInstall, false)
  assert.strictEqual(p.installer, null)
  assert.strictEqual(p.torchIndex, null)
})

test('macOS ohne Homebrew nennt den Befehl, der Homebrew installiert — nicht `brew install`', () => {
  // Vorher stand hier `brew install python ffmpeg whisper-cpp`. Ohne Homebrew endet das mit
  // "command not found: brew" — ein Rat, der genau dem nicht hilft, der ihn braucht.
  const p = plan('darwin', '', 'arm64', false)
  assert.match(p.hinweis, /Homebrew/)
  assert.match(p.hinweis, /install\.sh/)
})

test('macOS MIT Homebrew installiert die App selbst (brew install braucht kein sudo)', () => {
  const p = plan('darwin', '', 'arm64', true)
  assert.strictEqual(p.autoInstall, true)
  assert.strictEqual(p.installer, 'brew')
  assert.strictEqual(p.hinweis, '')
  assert.strictEqual(p.torchIndex, null)
})

test('macOS arm64: whisper-cpp gehoert zu den Paketen (die schnelle Engine)', () => {
  assert.deepStrictEqual(plan('darwin', '', 'arm64', true).brewPakete,
    ['python', 'ffmpeg', 'whisper-cpp'])
})

test('Intel-macOS: kein whisper-cpp — dort rechnet ohnehin faster-whisper', () => {
  // webtool/device.py:asr_engine prueft arm64. Auf einem Intel-Mac waere das Paket ein
  // Download, der nichts bewirkt — python und ffmpeg braucht er aber weiter.
  assert.deepStrictEqual(plan('darwin', '', 'x64', true).brewPakete, ['python', 'ffmpeg'])
})

test('Linux bleibt beim Hinweis — apt/dnf/pacman brauchen echtes sudo', () => {
  assert.strictEqual(plan('linux', 'apt').installer, null)
  assert.match(plan('linux', 'apt').hinweis, /sudo/)
})

test('nutztWhisperCpp gilt nur fuer macOS auf arm64', () => {
  const { nutztWhisperCpp } = require('./setup')
  assert.strictEqual(nutztWhisperCpp('darwin', 'arm64'), true)
  assert.strictEqual(nutztWhisperCpp('darwin', 'x64'), false)
  assert.strictEqual(nutztWhisperCpp('win32', 'x64'), false)
  assert.strictEqual(nutztWhisperCpp('linux', 'arm64'), false)
})

test('Linux: erkannter Paketmanager steht im Hinweis', () => {
  assert.match(plan('linux', 'apt').hinweis, /apt install/)
  assert.match(plan('linux', 'dnf').hinweis, /dnf install/)
  assert.match(plan('linux', 'pacman').hinweis, /pacman -S/)
})

test('Linux ohne erkannten Paketmanager nennt trotzdem die Pakete', () => {
  const p = plan('linux', '')
  assert.strictEqual(p.autoInstall, false)
  assert.match(p.hinweis, /python3.*ffmpeg/s)
})

test('Linux zieht cu128 ohne vorherige NVIDIA-Erkennung', () => {
  assert.match(plan('linux', 'apt').torchIndex, /cu128/)
})

test('macOS: Homebrew-Pfade stehen VOR dem geerbten PATH (launchd kennt sie nicht)', () => {
  const pfad = aufPlattform('darwin', () => spawnEnv().PATH)
  assert.ok(pfad.startsWith('/opt/homebrew/bin:/usr/local/bin:'),
    `Homebrew muss vorne stehen, sonst gewinnt /usr/bin/python3 (3.9): ${pfad}`)
  assert.ok(pfad.endsWith(process.env.PATH || ''))     // geerbtes PATH bleibt dahinter
})

test('macOS: das Nutzer-bin ist dabei — dort landet claude', () => {
  const pfad = aufPlattform('darwin', () => spawnEnv().PATH)
  const nutzerBin = require('path').join(require('os').homedir(), '.local', 'bin')
  // Kein split(':') — auf einem Windows-Entwicklungsrechner enthaelt homedir() den
  // Laufwerksbuchstaben ("C:\Users\..."), der Trenner zerlegte den Pfad mitten durch.
  assert.ok(pfad.includes(nutzerBin),
    `~/.local/bin fehlt, shutil.which("claude") findet nichts: ${pfad}`)
})

test('backend.js startet uvicorn mit spawnEnv, nicht mit blankem process.env', () => {
  // Naht-Test: der Serverprozess vererbt seine Umgebung an jeden Job (jobs.py nutzt
  // {**os.environ}). Faellt spawnEnv hier weg, sucht claude/ffmpeg wieder im leeren PATH.
  const quelle = require('fs').readFileSync(require('path').join(__dirname, 'backend.js'), 'utf8')
  assert.match(quelle, /\.\.\.S\.spawnEnv\(\)/,
    'backend.js muss die uvicorn-Umgebung ueber setup.spawnEnv() bauen')
  assert.ok(!/env:\s*\{\s*\.\.\.process\.env/.test(quelle),
    'blankes ...process.env im uvicorn-env waere der alte, kaputte Zustand')
})

test('Windows und Linux erben die Umgebung unveraendert', () => {
  assert.strictEqual(aufPlattform('win32', spawnEnv), process.env)
  assert.strictEqual(aufPlattform('linux', spawnEnv), process.env)
})

test('ffmpeg wird im winget-Paketordner gefunden — dort steht es nie auf dem PATH', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
  const wurzel = fs.mkdtempSync(path.join(os.tmpdir(), 'winget-'))
  const bin = path.join(wurzel, 'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe',
    'ffmpeg-9.0-full_build', 'bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(bin, 'ffmpeg.exe'), '')
  assert.strictEqual(wingetFfmpeg(wurzel), path.join(bin, 'ffmpeg.exe'))
})

test('fehlendes winget-Verzeichnis liefert Leerstring statt zu werfen', () => {
  assert.strictEqual(wingetFfmpeg(String.raw`C:\gibt-es-nicht-42`), '')
})

/** Eine venv-Attrappe in einem Wegwerf-Ordner — NIE die echte .venv des Entwicklers. */
function leereVenv() {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
  return fs.mkdtempSync(path.join(os.tmpdir(), 'venv-'))
}

/** Eine requirements.txt zum Anfassen — die echte darf ein Test nicht veraendern. */
function reqDatei(inhalt) {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'req-')), 'requirements.txt')
  fs.writeFileSync(p, inhalt)
  return p
}

test('venv ohne Merker gilt als veraltet — jede heute bestehende Installation ist es (#181)', () => {
  const { paketeAktuell } = require('./setup')
  assert.strictEqual(paketeAktuell(leereVenv(), reqDatei('faster-whisper\n')), false)
})

test('eine GEAENDERTE requirements.txt entwertet den Merker — daran haengt der ganze Zweck', () => {
  const { paketeAktuell, stempelSchreiben } = require('./setup')
  const venv = leereVenv()
  const alt = reqDatei('faster-whisper\n'), neu = reqDatei('faster-whisper\npackaging\n')
  assert.strictEqual(stempelSchreiben(venv, alt), true)
  assert.strictEqual(paketeAktuell(venv, alt), true)
  // Der Kern: der Merker muss AN DER DATEI haengen. Einen Test, der nur den Merker verbiegt,
  // ueberlebt ein reqHash(), das eine Konstante liefert — und damit #181 unbemerkt wieder oeffnet.
  assert.strictEqual(paketeAktuell(venv, neu), false)
})

test('Kommentare, Zeilenenden und Reihenfolge entwerten den Merker NICHT (#229)', () => {
  const { paketeAktuell, stempelSchreiben } = require('./setup')
  const venv = leereVenv()
  assert.strictEqual(stempelSchreiben(venv, reqDatei('# warum das hier steht\nfaster-whisper\npackaging\n')), true)
  // Dieselben zwei Anforderungen, andere Prosa + CRLF + andere Reihenfolge. Roh gehasht war
  // das drei getrennte Gruende, jedem Nutzer eine Einrichtungsrunde aufzuerlegen, die nichts tut.
  assert.strictEqual(
    paketeAktuell(venv, reqDatei('# eine voellig andere, laengere Erklaerung\r\npackaging\r\n\r\nfaster-whisper\r\n')),
    true)
  // Die Gegenrichtung MUSS weiter greifen — ohne sie haengt der Merker an nichts mehr, und
  // #181 waere still wieder offen. Ein `reqHash`, das eine Konstante liefert, faellt hier durch.
  assert.strictEqual(paketeAktuell(venv, reqDatei('faster-whisper\n')), false)
})

test('ein URL-Fragment ist KEIN Kommentar — zwei Pins duerfen nicht gleich hashen (#229)', () => {
  // pip schneidet einen Kommentar nur am Zeilenanfang oder nach Leerraum. Mit blossem `#`
  // normalisierten diese beiden Zeilen auf denselben Text: zwei verschiedene Paketstaende,
  // ein Merker, "aktuell" — die Einrichtung wird nicht angeboten, das neue Pin erreicht den
  // Nutzer NIE. Der rohe Byte-Hash konnte das nicht; es waere der Schaden aus #181, neu
  // aufgemacht von seiner eigenen Reparatur.
  const { paketeAktuell, stempelSchreiben } = require('./setup')
  const venv = leereVenv()
  const a = reqDatei('torch @ https://h/t-2.8.0.whl#sha256=aaa\n')
  const b = reqDatei('torch @ https://h/t-2.8.0.whl#sha256=bbb\n')
  assert.strictEqual(stempelSchreiben(venv, a), true)
  assert.strictEqual(paketeAktuell(venv, a), true)
  assert.strictEqual(paketeAktuell(venv, b), false)
})

test('unlesbare requirements.txt heisst "nichts nachzuziehen", nicht "veraltet"', () => {
  const { paketeAktuell } = require('./setup')
  // Die Gegenrichtung waere eine Einrichtung, die bei jedem Start erscheint und nie gelingen kann.
  assert.strictEqual(paketeAktuell(leereVenv(), String.raw`C:\gibt-es-nicht-42\requirements.txt`), true)
})

test('ein nicht anlegbarer Merker meldet sich als nicht schreibbar (#230)', () => {
  const { stempelSchreibbar } = require('./setup')
  assert.strictEqual(stempelSchreibbar(leereVenv()), true, 'ein normaler Ordner ist schreibbar')
  assert.strictEqual(stempelSchreibbar(String.raw`C:\gibt-es-nicht-42`), false)
})

test('ein schreibgeschuetzter Merker zaehlt auch — nicht nur ein fehlender Ordner (#230)', (t) => {
  // Der Fall, um den es geht: ein per Attribut oder fremdem Handle gesperrter Merker liegt in
  // einem sonst voellig schreibbaren Ordner. `accessSync(W_OK)` stand hier zuerst und sieht ihn
  // NICHT — es fragt Metadaten ab und oeffnet die Datei nie.
  const fs = require('node:fs'), path = require('node:path')
  const { stempelSchreibbar } = require('./setup')
  const venv = leereVenv()
  const p = path.join(venv, '.requirements')
  fs.writeFileSync(p, 'HASH')
  fs.chmodSync(p, 0o444)
  // Nachgemessen statt angenommen: als root (Container-CI) laesst sich eine Datei so nicht
  // sperren, und dann belegte die Behauptung darunter nichts. `t.skip` statt `return` — ein
  // blosses return waere ein BESTANDENER Test, und der Schutz bliebe unsichtbar.
  try { fs.appendFileSync(p, 'y'); return t.skip('als root laesst sich die Datei nicht sperren') }
  catch { /* wirklich gesperrt — weiter */ }
  assert.strictEqual(stempelSchreibbar(venv), false)
  assert.strictEqual(fs.readFileSync(p, 'utf8'), 'HASH', 'die Probe darf den Merker nicht anfassen')
})

test('die Probe laesst einen schreibbaren Merker unveraendert (#230)', () => {
  // Sie haengt NICHTS an. Wuerde sie den heutigen Hash schreiben (der naheliegende Reflex),
  // erklaerte sie eine venv fuer fertig, der Pakete fehlen — und die Einrichtungsseite
  // verschwaende, statt zu erklaeren.
  const fs = require('node:fs'), path = require('node:path')
  const { stempelSchreibbar, paketeAktuell } = require('./setup')
  const venv = leereVenv()
  const req = reqDatei('faster-whisper\n')
  fs.writeFileSync(path.join(venv, '.requirements'), 'EIN-ALTER-HASH')
  assert.strictEqual(stempelSchreibbar(venv), true)
  assert.strictEqual(fs.readFileSync(path.join(venv, '.requirements'), 'utf8'), 'EIN-ALTER-HASH')
  assert.strictEqual(paketeAktuell(venv, req), false, 'und der Stand bleibt "veraltet"')
})

test('nur importierbar UND aktuell startet den Server — beides einzeln reicht nicht', () => {
  const { venvZustand } = require('./setup')
  // Diese Entscheidung liest main.js (`if (s.venv) serverStarten()`). Stuende sie nur inline
  // in status(), liesse `venv: importe` einen veralteten Stand durch, ohne dass ein Test murrt.
  assert.deepStrictEqual(venvZustand(true, true), { venv: true, venvVeraltet: false })
  assert.deepStrictEqual(venvZustand(true, false), { venv: false, venvVeraltet: true })
  // Ohne Importe ist die venv nicht "veraltet", sondern gar nicht da — sonst stuende auf der
  // Seite "vorhanden, aber nicht auf dem neuesten Stand" ueber einem leeren Ordner.
  assert.deepStrictEqual(venvZustand(false, false), { venv: false, venvVeraltet: false })
  assert.deepStrictEqual(venvZustand(false, true), { venv: false, venvVeraltet: false })
})

test('ein CPU-Rad nach dem Nachlauf wird erkannt — sonst waere die GPU still weg', () => {
  const { cudaVerloren } = require('./setup')
  const mitIndex = { torchIndex: 'https://download.pytorch.org/whl/cu128' }
  assert.strictEqual(cudaVerloren(mitIndex, 'CUDA=12.8'), false)
  assert.strictEqual(cudaVerloren(mitIndex, 'CUDA='), true)
  // Die Marke ist noetig, weil `ausgabe` stderr mitliest: eine Warnung beim Import macht
  // einen blossen Leerstring-Vergleich blind.
  assert.strictEqual(cudaVerloren(mitIndex, 'UserWarning: irgendwas\nCUDA='), true)
  // Keine verwertbare Antwort (torch laesst sich gar nicht importieren, `ausgabe` -> null):
  // nichts tun. Die Pruefung danach meldet die kaputte venv, ein GB-Download waere geraten.
  assert.strictEqual(cudaVerloren(mitIndex, null), false)
  // macOS hat keinen CUDA-Index; dort ist `torch.version.cuda` IMMER leer.
  assert.strictEqual(cudaVerloren({ torchIndex: null }, 'CUDA='), false)
})

/**
 * Faehrt cudaZurueckholen mit nachgebautem Werkzeug: was torch meldet, wie pip ausgeht.
 * Die pip-AUFRUFE werden mitgeschrieben, nicht nur die Ausgabe — sonst bliebe „loest keinen
 * Nachlauf aus" gruen, solange der Nachlauf dabei nur schweigt.
 */
async function nachholen(cudaAntwort, pipCode) {
  const { cudaZurueckholen } = require('./setup')
  const zeilen = [], pip = []
  const rein = {
    ausgabe: async () => cudaAntwort,
    lauf: async (cmd, args) => { pip.push(args); return pipCode },
  }
  const ok = await cudaZurueckholen('py', { torchIndex: 'https://x/cu128' }, z => zeilen.push(z), rein)
  return { ok, zeilen, pip }
}

test('heiles CUDA loest keinen Nachlauf aus — kein GB-Download auf gut Glueck', async () => {
  const { ok, zeilen, pip } = await nachholen('CUDA=12.8', 0)
  assert.strictEqual(ok, true)
  assert.deepStrictEqual(pip, [], 'bei heilem torch darf kein pip starten')
  assert.deepStrictEqual(zeilen, [], 'und auch nichts gemeldet werden')
})

test('ein gescheitertes Zurueckholen nennt die FOLGE, nicht nur den Fehlschlag', async () => {
  // "pip exit 1" im Protokoll sagt niemandem, dass ab jetzt die CPU rechnet. Der Lauf bricht
  // bewusst NICHT ab (langsam ist besser als gar nicht) — dann ist die Meldung das Einzige,
  // woran der Nutzer den Verlust ueberhaupt bemerkt.
  const { ok, zeilen, pip } = await nachholen('CUDA=', 1)
  assert.strictEqual(ok, false)
  assert.strictEqual(pip.length, 1)
  assert.ok(pip[0].includes('--index-url') && pip[0].includes('https://x/cu128'),
    `der Nachlauf muss den CUDA-Index nennen: ${pip[0].join(' ')}`)
  // GEZIELT die Fehlerzeile: die allgemeine Verlustmeldung davor enthaelt selbst schon "CPU",
  // eine Suche ueber den ganzen Text waere also erfuellt, ohne dass der Fehlschlag etwas sagt.
  const fehlerzeile = zeilen.find(z => z.includes('fehlgeschlagen'))
  assert.ok(fehlerzeile, 'der Fehlschlag muss ueberhaupt gemeldet werden')
  assert.match(fehlerzeile, /CPU/)
  assert.match(fehlerzeile, /Einstellungen/, 'die Meldung muss sagen, wo es zu beheben ist')
})

test('ein gegluecktes Zurueckholen meldet keinen Verlust', async () => {
  const { ok, zeilen, pip } = await nachholen('CUDA=', 0)
  assert.strictEqual(ok, true)
  assert.strictEqual(pip.length, 1)
  assert.ok(!zeilen.some(z => z.includes('fehlgeschlagen')))
})

/**
 * Faehrt `einrichten()` mit nachgebautem Werkzeug (#232). Die Vorgabe ist der glatte Fall:
 * alles gefunden, jeder Aufruf gelingt. Jeder Test setzt NUR die Stelle um, die er beweisen
 * will — sonst steht in jedem Test eine vollstaendige Attrappe, und die naechste
 * hinzukommende Abhaengigkeit faellt in allen gleichzeitig auf die echte Funktion zurueck.
 *
 * Aufgezeichnet werden die AUFRUFE, nicht nur der Ausgang: „schreibt keinen Merker" bliebe
 * sonst gruen, solange der Merker nur nichts zurueckmeldet.
 */
async function einrichtenMit(ueber = {}) {
  const { einrichten } = require('./setup')
  const spur = { zeilen: [], schritte: [], rufe: [], merker: 0 }
  const roh = {
    planen: async () => ({ installer: 'winget', autoInstall: true, brewPakete: [], hinweis: '',
                           torchIndex: 'https://x/cu128' }),
    findePython: async () => ({ cmd: 'py', args: ['-3'], version: '3.13' }),
    findeFfmpeg: async () => 'C:\\ffmpeg.exe',
    findeWhisperCpp: async () => '',
    exists: () => true,
    mkdir: () => {},
    lauf: async () => 0,
    cudaZurueckholen: async () => true,
    importeDa: async () => true,
    stempelSchreiben: () => true,
    ...ueber,
  }
  // Mitgeschrieben wird UM die Ueberschreibung herum, nicht in ihr: sonst muesste jeder Test,
  // der nur einen Rueckgabewert umbiegen will, die Buchfuehrung mitschleppen — und der erste,
  // der es vergisst, prueft still nichts mehr.
  spur.r = await einrichten(z => spur.zeilen.push(z), s => spur.schritte.push(s), {
    ...roh,
    lauf: async (cmd, args) => { spur.rufe.push([cmd, args.join(' ')]); return roh.lauf(cmd, args) },
    stempelSchreiben: (...a) => { spur.merker++; return roh.stempelSchreiben(...a) },
  })
  return spur
}

/** Die Aufrufe an Python/pip — alles ausser den Paketmanagern der Plattform. */
const pipZeilen = spur => spur.rufe.filter(([c]) => c !== 'winget' && c !== 'brew').map(([, a]) => a)

test('der glatte Lauf VERMERKT den Paketstand — sonst kommt die Seite bei jedem Start wieder', async () => {
  // Die Positivrichtung. Ohne sie sind alle uebrigen Merker-Tests `merker === 0`, und ein
  // `else if (false)` an der Schreibstelle bliebe unsichtbar (nachgefahren: 83 pass, 0 fail) —
  // ausgerechnet der Zustand, den #230 nur noch ERKLAEREN, nicht verhindern kann.
  const spur = await einrichtenMit()
  assert.strictEqual(spur.r.ok, true)
  assert.strictEqual(spur.merker, 1)
})

test('scheitert das Anlegen der venv, bricht der Lauf ab und vermerkt nichts', async () => {
  const spur = await einrichtenMit({
    exists: () => false,                                    // keine venv da -> anlegen
    lauf: async (cmd, args) => (args.join(' ').includes('-m venv') ? 1 : 0),
  })
  assert.strictEqual(spur.r.ok, false)
  assert.match(spur.r.fehler, /venv/)
  assert.strictEqual(spur.merker, 0)
})

test('fehlendes Python holt der Installer nach — und meldet, wenn es danach nicht im PATH steht', async () => {
  let n = 0
  const nachInstall = await einrichtenMit({
    findePython: async () => (++n > 1 ? { cmd: 'py', args: ['-3'], version: '3.13' } : null),
  })
  assert.strictEqual(nachInstall.r.ok, true)
  assert.ok(nachInstall.rufe.some(([c, a]) => c === 'winget' && a.includes('Python.Python.3.13')),
    'der Installer muss ueberhaupt gerufen werden')

  // Der Fall, den winget hinterlaesst, ohne dass er scheitert: installiert, aber noch nicht im
  // PATH dieses Prozesses. Ohne eigene Meldung stuende dort "Kein Python >= 3.10 gefunden" —
  // und der Nutzer suchte einen Fehler, den ein Neustart behebt.
  const nie = await einrichtenMit({ findePython: async () => null })
  assert.strictEqual(nie.r.ok, false)
  assert.match(nie.r.fehler, /PATH/)
})

test('nach einem gescheiterten CUDA-Nachlauf wird der Merker NICHT geschrieben (#232)', async () => {
  // Genau die Zeile, die #232 als unpruefbar benannt hat: sie steckt zwischen zwei echten
  // pip-Laeufen. Wuerde der Merker hier geschrieben, gaelte die venv als fertig, die
  // Einrichtung wuerde nie wieder angeboten — und der Hinweis auf der Einstellungsseite
  // („dann die Umgebung neu einrichten") zeigte auf einen Weg, den es nicht mehr gibt.
  const spur = await einrichtenMit({ cudaZurueckholen: async () => false })
  assert.strictEqual(spur.r.ok, true, 'der Lauf bricht bewusst NICHT ab — langsam ist besser als gar nicht')
  assert.strictEqual(spur.merker, 0, 'ohne heiles torch darf der Paketstand nicht vermerkt werden')
  assert.ok(spur.zeilen.some(z => z.includes('nicht vermerkt')),
    'und der Nutzer muss erfahren, warum die Seite wiederkommt')
})

test('eine gescheiterte Importpruefung meldet ok:false und schreibt keinen Merker', async () => {
  // Der Merker behauptet „fertig eingerichtet gegen diese requirements.txt". Ueber eine venv,
  // die sich nicht importieren laesst, darf er das nicht sagen.
  const spur = await einrichtenMit({ importeDa: async () => false })
  assert.strictEqual(spur.r.ok, false)
  assert.match(spur.r.fehler, /unvollstaendig/)
  assert.strictEqual(spur.merker, 0)
})

test('faellt das CUDA-Rad aus, laeuft torch vom Standardindex nach — der Lauf geht weiter', async () => {
  // Die teuerste Verzweigung der Datei: hier entscheidet sich, ob der Nutzer die GPU behaelt
  // oder still auf der CPU landet. Ein Abbruch waere die falsche Richtung.
  const spur = await einrichtenMit({
    lauf: async (cmd, args) => {
      const z = args.join(' ')
      return z.includes('install torch') && z.includes('--index-url') ? 1 : 0
    },
  })
  assert.strictEqual(spur.r.ok, true)
  const torch = pipZeilen(spur).filter(z => z.includes('install torch'))
  assert.strictEqual(torch.length, 2, `erst mit Index, dann ohne: ${torch.join(' | ')}`)
  assert.ok(torch[0].includes('--index-url'))
  assert.ok(!torch[1].includes('--index-url'), 'der zweite Versuch muss das Standardrad nehmen')
  assert.ok(pipZeilen(spur).some(z => z.includes('-r ')), 'und danach laeuft der Rest weiter')
})

test('ein gescheitertes ffmpeg bricht NICHT ab, ein gescheitertes `-r` schon', async () => {
  // Die Asymmetrie ist die Entscheidung: ohne ffmpeg laesst sich immerhin noch bearbeiten,
  // ohne die Python-Pakete gar nichts. Beide Richtungen zusammen, sonst belegt der Test nur
  // eine Haelfte und die andere darf unbemerkt kippen.
  const ohneFfmpeg = await einrichtenMit({
    findeFfmpeg: async () => '',
    lauf: async (cmd, args) => (cmd === 'winget' ? 1 : 0),
  })
  assert.strictEqual(ohneFfmpeg.r.ok, true, 'ffmpeg-Fehlschlag darf die Einrichtung nicht kippen')

  const ohnePakete = await einrichtenMit({
    lauf: async (cmd, args) => (args.join(' ').includes('-r ') ? 1 : 0),
  })
  assert.strictEqual(ohnePakete.r.ok, false)
  assert.match(ohnePakete.r.fehler, /Python-Pakete/)
  assert.strictEqual(ohnePakete.merker, 0, 'nach einem Abbruch darf kein Merker liegenbleiben')
})

// --- Abbrechen (#242): der längste Lauf der App war der einzige ohne Rückweg ---

test('Abbruch während des PyTorch-Schritts: eigenes Ergebnis, kein Merker, kein Nachlauf', async () => {
  const { abbrechen } = require('./setup')
  const spur = await einrichtenMit({
    lauf: async (cmd, args) => {
      if (args.join(' ').includes('install torch')) abbrechen()   // mitten im Schritt gefragt
      return 0
    },
  })
  assert.strictEqual(spur.r.ok, false)
  assert.strictEqual(spur.r.abgebrochen, true)
  assert.match(spur.r.fehler, /Abgebrochen/, 'kein Installationsfehler-Text für einen gewollten Abbruch')
  assert.strictEqual(spur.merker, 0)
  assert.ok(!pipZeilen(spur).some(a => a.includes('-r ')), 'pip -r darf nach dem Abbruch nicht mehr laufen')
})

test('ein neuer Lauf beginnt ohne den Abbruch-Merker des vorigen', async () => {
  const { abbrechen } = require('./setup')
  abbrechen()
  const spur = await einrichtenMit()
  assert.strictEqual(spur.r.ok, true, 'ein hängengebliebener Merker täte jeden Folgelauf töten')
  assert.strictEqual(spur.merker, 1)
})

test('abbrechen tötet den laufenden Schritt wirklich (echter Prozess, echter Baum-Töter)', { timeout: 20000 }, async () => {
  const { lauf, abbrechen } = require('./setup')
  const p = lauf(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], () => {})
  await new Promise(r => setTimeout(r, 1000))     // den Prozess laufen lassen
  abbrechen()
  const code = await p
  assert.notStrictEqual(code, 0, 'der Prozess muss getötet sein, nicht sauber beendet')
})

test('ein Abbruch aus der Zeit eines Sondierungs-Schritts erstickt den nächsten Lauf im Ansatz', { timeout: 15000 }, async () => {
  // abbrechen() trifft oft, während kein laufender Schritt registriert ist (kurze
  // Sondierungen wie findePython laufen ueber ausgabe, nicht lauf). Ohne den
  // Eintritts-Wächter wuerde der NAECHSTE Prozess trotzdem starten — und niemand
  // toetet ihn mehr: eine Waise, die Dateien der venv offen haelt, waehrend die
  // Seite "Abgebrochen" zeigt.
  const { lauf, abbrechen } = require('./setup')
  abbrechen()
  const start = Date.now()
  const code = await lauf(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], () => {})
  assert.strictEqual(code, -1)
  assert.ok(Date.now() - start < 5000, 'der Prozess darf gar nicht erst laufen')
})

test('abbrechen nimmt den ProzessBAUM mit — auch den Enkel', { timeout: 25000 }, async () => {
  // /T bzw. die Prozessgruppe sind die Zusicherung; ohne sie staerbe nur das direkte
  // Kind, und der Enkel schriebe als Waise weiter in die venv. Der Test macht den
  // Unterschied sichtbar: ein Enkel, der ueberlebt, faellt auf.
  const { lauf, abbrechen } = require('./setup')
  const enkel = []
  const p = lauf(process.execPath, ['-e', [
    "const c = require('child_process').spawn(process.execPath,",
    "  ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })",
    "console.log('ENKEL=' + c.pid)",
    "setTimeout(() => {}, 60000)",
  ].join('\n')], z => { const m = /ENKEL=(\d+)/.exec(z); if (m) enkel.push(Number(m[1])) })
  for (let i = 0; i < 50 && enkel.length === 0; i++) await new Promise(r => setTimeout(r, 100))
  assert.strictEqual(enkel.length, 1, 'die Enkel-PID muss durchs Log kommen')
  abbrechen()
  const code = await p
  assert.notStrictEqual(code, 0, 'der Hauptprozess stirbt')
  let lebt = true
  for (let i = 0; i < 50; i++) {
    try { process.kill(enkel[0], 0) } catch { lebt = false; break }
    await new Promise(r => setTimeout(r, 100))
  }
  assert.ok(!lebt, 'der Enkel muss mitsterben — sonst Waise, die in die venv schreibt')
})

'use strict'
/**
 * Der fehlende Test zu #251 — `main.js` war das einzige Electron-Modul ohne einen.
 *
 * Weg 3 des Issues: `main.js` LADBAR machen statt eine Formregel ueber seine Handler zu
 * erfinden. Die Attrappe ist dieselbe wie in `backend.test.js`/`setup.test.js`
 * (`Module._load`-Patch), nur breiter — `app`, `BrowserWindow`, `ipcMain`, `nativeTheme`,
 * `net`, `shell` plus die vier eigenen Module.
 *
 * **Warum MEHRFACH geladen wird:** die beiden Riegel dieser Datei (`startLaeuft`,
 * `einrichtungLaeuft`) und die Instanzsperre sind Modulzustand, der beim LADEN entsteht.
 * Ein einziges `require` koennte davon nur den zuletzt erreichten Zustand pruefen — und
 * `app.requestSingleInstanceLock()` faellt genau einmal, vor allem anderen. Deshalb
 * `laden()`: frische Attrappen, `require.cache` geleert, Modulrumpf laeuft erneut.
 *
 * **Was diese Tests NICHT koennen:** kein Fenster, kein Chromium, keine echte IPC-Bruecke.
 * Geprueft wird die VERDRAHTUNG — wer wen in welcher Reihenfolge ruft und welche Nutzlast
 * abgewiesen wird. Ob `setTitleBarOverlay` die Farbe wirklich malt, sagt hier niemand.
 * Die Entscheidungen selbst liegen ohnehin ausserhalb (`fenster.farbeGueltig`,
 * `updater.sollPruefen`, `backend.serverEnv`) und haben dort eigene Tests; genau das ist
 * die Aussage, die #251 dauerhaft festhalten wollte.
 */
const Module = require('node:module')
const test = require('node:test')
const assert = require('node:assert')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

// Die gerade geladene Welt — der `Module._load`-Patch steht global, die Attrappen wechseln.
let welt = null
/** Wegwerf-Verzeichnisse der Tests, die eine echte Protokolldatei brauchen. */
const temps = []

const echtesLaden = Module._load
Module._load = (req, ...rest) => {
  if (!welt) return echtesLaden(req, ...rest)
  if (req === 'electron') return welt.electron
  if (req === 'electron-updater') return welt.electronUpdater
  if (req === './backend') return welt.backend
  if (req === './setup') return welt.setup
  if (req === './protokoll') return welt.protokoll
  if (req === './updater') return welt.updater
  // Das echte SDK stirbt unter node an `process.versions.electron` und greift auf
  // `app.getAppPath`, `protocol`, `crashReporter`, `session` — die Attrappe zeichnet nur auf.
  if (req === '@sentry/electron/main') return welt.sentry
  // `./fenster` bleibt ECHT: `farbeGueltig`/`fortschrittGueltig` sind die Waechter, deren
  // Anwendung hier geprueft wird — mit einer Attrappe pruefte der Test seine eigene Zusage.
  return echtesLaden(req, ...rest)
}

function attrappen(opt = {}) {
  const w = {
    // Eine gemeinsame Spur statt vieler Zaehler: mehrere Zusicherungen dieser Datei sind
    // REIHENFOLGEN (Backend stoppen VOR dem Installieren), und die sieht man nur so.
    spur: [],
    protokollzeilen: [],
    gesendet: [],
    kanaele: new Map(),
    // Jeder Lauf bekommt sein eigenes userData (#530): der Opt-in-Schalter liegt dort als
    // Datei, und `os.tmpdir()` direkt liesse jeden Test den Zustand des vorigen erben.
    // `opt.daten` teilt ein Verzeichnis absichtlich — fuer den „zweiten Start".
    daten: opt.daten || (() => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'transkribor-main-')); temps.push(d); return d })(),
    dialoge: [],
    // Die Navigationshoerer aus #434 (`will-navigate`/`will-redirect`). Ohne diese Attrappe
    // wirft `fenster()` — beim Bau des Fixes wurden davon 36 Tests rot, was nebenbei belegt,
    // dass die Verdrahtung hier wirklich erreicht wird.
    navHoerer: new Map(),
    appEreignisse: new Map(),
    fenster: [],
    quits: 0,
    takt: null,              // Rumpf des 6-Stunden-Zeitgebers
    taktUnref: false,
    starten: null,           // das Versprechen aus app.whenReady().then(starten)
    status: opt.status || { venv: true, python: 'x' },
    startFehler: opt.startFehler || null,
    einrichtErgebnis: opt.einrichtErgebnis || { ok: true },
    updateZustand: opt.updateZustand || { art: 'kein-update' },
    serverLaeuft: false,     // erst nach `backend.start` kennt `url()` den echten Port
    online: opt.online !== false,
    sollPruefen: opt.sollPruefen !== false,
    erstellenWirft: !!opt.erstellenWirft,
  }

  let scheibe = null
  const scheibeBauen = () => {
    scheibe = {
      zerstoert: false,
      isDestroyed: () => scheibe.zerstoert,
      isMinimized: () => !!opt.minimiert,
      restore: () => w.spur.push('restore'),
      focus: () => w.spur.push('focus'),
      setMenuBarVisibility: () => {},
      loadFile: f => w.spur.push(`loadFile:${path.basename(f)}`),
      loadURL: u => w.spur.push(`loadURL:${u}`),
      setTitleBarOverlay: o => w.spur.push(`overlay:${o.color}/${o.symbolColor}/${o.height}`),
      setProgressBar: (a, o) => w.spur.push(`balken:${a}${o ? `:${o.mode}` : ''}`),
      on: () => {},
      webContents: {
        send: (kanal, nutzlast) => w.gesendet.push({ kanal, nutzlast }),
        setWindowOpenHandler: fn => { w.oeffnenHandler = fn },
        on: (art, fn) => { w.navHoerer.set(art, fn) },
        // Der Berechtigungs-Handler haengt an der SESSION, nicht an `webContents` (#446) —
        // `electron.d.ts` fuehrt `setPermissionRequestHandler` unter `Session`. Die Attrappe
        // bildet genau diesen Umweg nach; haenge ihn jemand ans falsche Objekt, wirft der
        // Fensterbau, statt still nichts zu tun.
        // Beide Handler, weil `fenster()` beide haengt (#518): der zweite ist der Gegenpart
        // fuer `navigator.permissions.query(...)`. Dass sein Fehlen den Fensterbau wirft und
        // nicht still nichts tut, ist gemessen — ohne diese Zeile fallen 61 der 62 Tests um.
        session: {
          setPermissionRequestHandler: fn => { w.berechtigungHandler = fn },
          setPermissionCheckHandler: fn => { w.berechtigungPruefer = fn },
        },
      },
    }
    return scheibe
  }

  w.electron = {
    app: {
      isPackaged: !!opt.gepackt,
      commandLine: { appendSwitch: s => w.spur.push(`schalter:${s}`) },
      getPath: () => w.daten,
      getVersion: () => '9.9.9',
      requestSingleInstanceLock: () => opt.sperre !== false,
      quit: () => { w.quits++ },
      focus: () => w.spur.push('app.focus'),
      // Thenable statt Promise: so faellt das Versprechen aus `.then(starten)` in die Hand
      // des Tests — und ob `whenReady` ueberhaupt abonniert wurde, ist selbst eine
      // Zusicherung (Instanzsperre).
      whenReady: () => ({ then: fn => (w.starten = Promise.resolve().then(fn)) }),
      on: (n, fn) => { w.appEreignisse.set(n, fn) },
    },
    BrowserWindow: function (o) { w.fenster.push(o); return scheibeBauen() },
    ipcMain: { handle: (n, fn) => { w.kanaele.set(n, fn) } },
    shell: {
      showItemInFolder: p => w.spur.push(`zeigen:${p}`),
      openPath: async p => { w.spur.push(`openPath:${p}`); return opt.openPathFehler || '' },
      openExternal: u => {
        w.spur.push(`extern:${u}`)
        return opt.externFehler ? Promise.reject(new Error(opt.externFehler)) : Promise.resolve()
      },
    },
    nativeTheme: { shouldUseDarkColors: !!opt.dunkel },
    net: { isOnline: () => w.online },
    // Das Zustimmungsfenster (#530): `opt.antwort` 0 = Ja, sonst Nein (Vorgabe wie `cancelId`).
    dialog: {
      showMessageBox: async (_win, o) => { w.dialoge.push(o); return { response: opt.antwort ?? 1 } },
    },
  }
  w.electronUpdater = { autoUpdater: {} }
  // Ohne Spur-Eintrag: `init` laeuft VOR `appendSwitch`, und die Zusicherung „HTTP/2 ist das
  // Erste in der Spur" (#150) soll davon unberuehrt bleiben. Ob init vor whenReady lief,
  // sagt `sentryVorReady` — `w.starten` entsteht erst mit dem whenReady-Abonnement.
  w.sentry = {
    init: o => {
      w.sentryOptionen = o
      w.sentryVorReady = !w.starten
      // VOR `appendSwitch`, nicht nur vor whenReady: was davor wirft, sieht das SDK nicht.
      w.sentryVorSchalter = !w.spur.includes('schalter:disable-http2')
    },
    close: async () => { w.spur.push('sentry.close'); return true },
    IPCMode: { Classic: 1, Protocol: 2, Both: 3 },
  }
  w.backend = {
    start: (onLine, extra) => {
      w.spur.push('backend.start')
      w.startExtras = extra
      if (opt.logZeile) onLine(opt.logZeile)
      if (w.startFehler) return Promise.reject(w.startFehler)
      // Der Port entsteht IM Start (backend.js:78) — vorher liefert `url()` einen Platzhalter.
      // Eine Attrappe, die immer denselben Wert liefert, macht die Zusicherung „die eigenen
      // Herkuenfte werden zur LAUFZEIT erfragt" unpruefbar: gemessen blieben mit ihr 55 von 55
      // Tests gruen, als die Liste versuchsweise beim Fensterbau eingefroren wurde.
      w.serverLaeuft = true
      return Promise.resolve()
    },
    stop: () => w.spur.push('backend.stop'),
    url: () => (w.serverLaeuft ? 'http://127.0.0.1:8000/' : 'http://127.0.0.1:0/'),
    projektePfad: async () => { w.spur.push('backend.projektePfad'); return '/pfad/zu/projekte' },
    log: () => ['zeile'],
  }
  w.setup = {
    status: async () => w.status,
    einrichten: async (onLog, onPhase) => {
      w.spur.push('setup.einrichten')
      if (opt.einrichtLog) onLog(opt.einrichtLog)
      if (opt.einrichtPhase) onPhase(opt.einrichtPhase)
      return w.einrichtErgebnis
    },
    abbrechen: () => w.spur.push('setup.abbrechen'),
  }
  // Der Fehlerbericht LIEST die Datei — also gibt es fuer diesen Fall eine echte, sonst
  // bliebe der Protokollteil des Berichts immer leer und die Zusicherungen darauf vacuous.
  const logpfad = opt.logtext === undefined
    ? '/pfad/zu/transkribor.log'
    : path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tk-log-')), 'transkribor.log')
  if (opt.logtext !== undefined) { fs.writeFileSync(logpfad, opt.logtext); temps.push(path.dirname(logpfad)) }
  w.logpfad = logpfad
  w.protokoll = {
    pfad: () => logpfad,
    // Kein Durchreicher: die Maskierung ist eine ZUSICHERUNG des Berichts, und eine
    // Attrappe, die nichts tut, liesse sie unbewacht (`maskiere` ganz weglassen ⇒ gruen).
    maskiere: z => String(z).replace(/sk-[A-Za-z0-9-]{12,}/g, '***[API-KEY]***'),
    // Schreibt AUCH in die Datei, wenn es eine gibt — sonst ist die Zusicherung „die Marke
    // verdraengt keine echte Zeile" vacuous: der Bericht liest die Datei, und eine Attrappe,
    // die nur in ein Array schiebt, macht jede Reihenfolge gruen (gemessen).
    schreiben: z => {
      w.protokollzeilen.push(String(z))
      if (opt.logtext !== undefined) fs.appendFileSync(logpfad, `${z}\n`)
    },
    kopf: () => w.spur.push('protokoll.kopf'),
    befund: (t, o) => w.spur.push(`befund:${t}:${Object.keys(o || {}).join(',')}`),
  }
  const laufend = {
    zustand: () => w.updateZustand,
    pruefen: () => w.spur.push('update.pruefen'),
    laden: () => w.spur.push('update.laden'),
    installieren: () => w.spur.push('update.installieren'),
  }
  w.updater = {
    macUrls: () => ({ feed: 'f', release: 'r' }),
    erstellen: o => {
      if (w.erstellenWirft) throw new Error('kaputt')
      w.aendert = o.aendert
      w.spur.push('updater.erstellen')
      return laufend
    },
    sollPruefen: () => w.sollPruefen,
    nachFehler: () => { w.spur.push('updater.nachFehler'); return laufend },
  }
  return w
}

/** Frische Attrappen, `main.js` neu laden, den Startlauf abwarten. */
async function laden(opt = {}) {
  welt = attrappen(opt)
  const vorherigeExit = process.listeners('exit')
  // Der 6-Stunden-Takt entsteht erst IN `starten()`; der Griff bleibt deshalb bis nach dem
  // Abwarten liegen und wird sofort danach zurueckgegeben — `node:test` benutzt selbst Timer.
  // Dass in diesem Fenster kein fremder Timer entsteht, haengt daran, dass JEDER Wartepunkt
  // darin ein Microtask ist. Wer in `starten()` ein `await new Promise(r => setTimeout(r))`
  // einbaut, bricht das hier — und nicht dort, wo er es sucht.
  const echterTakt = globalThis.setInterval
  globalThis.setInterval = fn => { welt.takt = fn; return { unref: () => { welt.taktUnref = true } } }
  try {
    delete require.cache[require.resolve('./main')]
    require('./main')
    if (welt.starten) await welt.starten
  } finally {
    globalThis.setInterval = echterTakt
    // Jeder Ladevorgang haengt einen 'exit'-Hoerer an den ECHTEN Prozess (backend.stop).
    // Ohne das Abraeumen sammeln sich sie ueber die Tests bis zur MaxListeners-Warnung.
    for (const h of process.listeners('exit')) {
      if (!vorherigeExit.includes(h)) process.removeListener('exit', h)
    }
  }
  const w = welt
  w.ruf = (kanal, ...args) => w.kanaele.get(kanal)(({}), ...args)
  return w
}

test.after(() => {
  Module._load = echtesLaden
  for (const d of temps) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* egal */ } }
})

// ── Instanzsperre (#231) ──────────────────────────────────────────────────────
test('ohne Instanzsperre wird beendet — und NICHTS gestartet', async () => {
  // Der Punkt des Kommentars in main.js: `app.quit()` ist asynchron und sagt nicht zu, dass
  // `ready` ausbleibt. Deshalb haengt `starten` im else-Zweig. Ein `quit()` allein waere
  // hier gruen, obwohl die sterbende Instanz danach ein zweites uvicorn hochzoege.
  const w = await laden({ sperre: false })
  assert.strictEqual(w.quits, 1)
  assert.strictEqual(w.starten, null, 'whenReady darf gar nicht erst abonniert werden')
  assert.strictEqual(w.fenster.length, 0, 'kein Fenster')
  assert.ok(!w.spur.includes('backend.start'), 'kein zweiter Server')
})

test('mit Sperre laeuft der Start — Kopf, Fenster, Pruefung, Server', async () => {
  const w = await laden()
  assert.ok(w.spur.includes('protokoll.kopf'))
  assert.strictEqual(w.fenster.length, 1)
  assert.ok(w.spur.includes('loadFile:setup.html'), 'die Statusseite kommt VOR dem Server')
  assert.ok(w.spur.indexOf('loadFile:setup.html') < w.spur.indexOf('backend.start'))
  assert.ok(w.spur.includes('loadURL:http://127.0.0.1:8000/'))
})

test('die zweite Instanz holt das bestehende Fenster nach vorn', async () => {
  const w = await laden({ minimiert: true })
  w.appEreignisse.get('second-instance')()
  assert.ok(w.spur.includes('restore'))
  assert.ok(w.spur.includes('focus'))
})

// ── senden(): was ins Protokoll geht und was nicht ────────────────────────────
test('nur log und fehler landen im Protokoll — phase und status nicht', async () => {
  // Die Zusicherung aus dem Kopf von `senden`. Sie ist von aussen nur ueber die Kanaele
  // erreichbar: `status` schickt 'status', `serverStarten` schickt 'phase', und die
  // Rueckmeldung von `backend.start` schickt 'log'.
  const w = await laden({ logZeile: 'uvicorn laeuft' })
  // Die Nachfrage zu den Fehlerberichten (#530) schreibt ihre Antwort NACH dem Start — erst
  // abwarten, sonst zaehlt die Liste unten mal eine, mal zwei Zeilen.
  await kurzWarten()
  assert.ok(w.protokollzeilen.includes('uvicorn laeuft'))
  const kanaeleAnDenRenderer = w.gesendet.map(g => g.kanal)
  assert.ok(kanaeleAnDenRenderer.includes('phase') && kanaeleAnDenRenderer.includes('status'),
    'beides geht sehr wohl ins FENSTER')
  // ERSCHOEPFEND, nicht „enthaelt nicht": hier stand zuerst eine Suche nach dem Wortlaut der
  // Phase — und die blieb gruen, als die Mutation JEDEN Kanal mitschrieb, weil ein Objekt
  // als `[object Object]` landet und nach nichts aussieht, wonach man sucht.
  assert.deepStrictEqual(w.protokollzeilen,
    ['uvicorn laeuft', '— Fehlerberichte automatisch: aus (Nachfrage beim Start) —'],
    'Anzeigezustand (phase/status) gehoert nicht in die Datei')
})

test('ein Serverfehler steht als FEHLER-Zeile in der Datei — und der Start ist wiederholbar', async () => {
  const w = await laden({ startFehler: new Error('Port belegt') })
  assert.ok(w.protokollzeilen.some(z => z === 'FEHLER: Port belegt'))
  // `startLaeuft = null` im Fehlerzweig: sonst waere der Server fuer den Rest der Sitzung tot.
  const vorher = w.spur.filter(s => s === 'backend.start').length
  await w.ruf('status')
  assert.strictEqual(w.spur.filter(s => s === 'backend.start').length, vorher + 1)
})

test('ohne venv startet der Server NICHT — die Seite wartet auf den Klick', async () => {
  const w = await laden({ status: { venv: false } })
  assert.ok(!w.spur.includes('backend.start'))
  assert.ok(w.spur.some(s => s.startsWith('befund:Umgebungsbefund')), 'der Befund geht trotzdem in die Datei')
})

test('zwei status-Aufrufe starten den Server nur EINMAL (startLaeuft)', async () => {
  const w = await laden({ status: { venv: true } })
  await Promise.all([w.ruf('status'), w.ruf('status')])
  assert.strictEqual(w.spur.filter(s => s === 'backend.start').length, 1)
})

// ── Einrichtung: der Riegel und der gewollte Abbruch (#242) ───────────────────
test('zwei Klicks auf Einrichten ergeben EIN pip install (einrichtungLaeuft)', async () => {
  const w = await laden({ status: { venv: false } })
  const [a, b] = [w.ruf('einrichten'), w.ruf('einrichten')]
  await Promise.all([a, b])
  assert.strictEqual(w.spur.filter(s => s === 'setup.einrichten').length, 1)
})

test('nach dem Lauf ist der Riegel wieder offen (finally)', async () => {
  const w = await laden({ status: { venv: false } })
  await w.ruf('einrichten')
  await w.ruf('einrichten')
  assert.strictEqual(w.spur.filter(s => s === 'setup.einrichten').length, 2,
    'bliebe der Merker stehen, waere die Einrichtung fuer den Rest der Sitzung tot')
})

test('ein GEWOLLTER Abbruch ist kein Fehler (#242)', async () => {
  const w = await laden({ status: { venv: false }, einrichtErgebnis: { ok: false, abgebrochen: true, fehler: 'Abgebrochen' } })
  await w.ruf('einrichten')
  assert.ok(!w.gesendet.some(g => g.kanal === 'fehler'), 'nicht rot im Fenster')
  assert.ok(!w.protokollzeilen.some(z => z.startsWith('FEHLER:')), 'und keine FEHLER-Zeile in der Datei')
})

test('ein echter Fehlschlag der Einrichtung wird dagegen gemeldet', async () => {
  // Gegenrichtung zum Test darueber: ohne sie bliebe „meldet nie einen Fehler" gruen.
  const w = await laden({ status: { venv: false }, einrichtErgebnis: { ok: false, fehler: 'pip kaputt' } })
  await w.ruf('einrichten')
  assert.ok(w.gesendet.some(g => g.kanal === 'fehler' && g.nutzlast === 'pip kaputt'))
})

test('Abbrechen ohne laufende Einrichtung ist wirkungslos', async () => {
  const w = await laden()
  await w.ruf('einrichten:abbrechen')
  assert.ok(!w.spur.includes('setup.abbrechen'))
})

/**
 * `process.platform` ist read-only — fuer den Test kurz umbiegen und sicher zuruecksetzen.
 * Dasselbe Muster wie in `setup.test.js` und wie weiter unten fuer `process.resourcesPath`.
 *
 * **Synchron, und das ist hier keine Schlamperei, sondern Bedingung:** `w.ruf` ruft den
 * IPC-Handler direkt auf, und der Rumpf von `titelleisteFarbe` enthaelt kein `await`. Die
 * umgebogene Plattform umschliesst ihn also vollstaendig. Wer hier ein `await` hineinsetzt,
 * gibt die Plattform zurueck, BEVOR der Handler sie liest.
 */
function aufPlattform(p, fn) {
  const echt = process.platform
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
  try { return fn() } finally {
    Object.defineProperty(process, 'platform', { value: echt, configurable: true })
  }
}

// ── Die beiden Kanaele mit Nutzlast vom Renderer (Vertrauensgrenze) ───────────
//
// **Beide Zweige werden auf JEDER Plattform geprueft**, und das ist der Grund, warum dieser
// Test seit #251 zweigeteilt ist: er verlangte den `overlay:`-Eintrag plattformBLIND und lief
// dabei nie auf einem Mac — das PR-CI-Bein „Electron" lief damals nur auf `ubuntu-latest`.
// Seit #464 ist es eine Matrix ueber ubuntu, windows und macos; der Satz beschreibt also den
// Zustand VOR diesem Umbau, nicht den heutigen. Aufgefallen
// ist es erst im Release-Lauf 33183032424, wo der macOS-Bau daran scheiterte und **kein
// Release** herauskam. Kein Produktfehler: `main.js` steigt auf `darwin` bewusst aus, weil es
// dort keine Overlay-Titelleiste gibt (`hiddenInset`, s. fenster.js).
test('titelleisteFarbe reicht nur geprueftes Hex durch — ausserhalb von macOS', async () => {
  const w = await laden()
  aufPlattform('win32', () => {
    w.ruf('titelleisteFarbe', null)
    w.ruf('titelleisteFarbe', { color: 'red', symbolColor: '#FAFAFA' })
    assert.ok(!w.spur.some(s => s.startsWith('overlay:')), 'ungeprueft wirft `f.color` bei null')
    w.ruf('titelleisteFarbe', { color: '#0b0b0f', symbolColor: '#fafafa' })
    assert.ok(w.spur.includes('overlay:#0b0b0f/#fafafa/40'), 'die Hoehe kommt aus fenster.js')
  })
})

test('auf macOS setzt titelleisteFarbe KEIN Overlay — die Wache ist das Verhalten', async () => {
  // Bis zu diesem Test hatte die `darwin`-Wache in `main.js` **keinen Sensor**: sie fiel nur
  // im Release-Lauf auf, und zwar als roter Test statt als roter Waechter. Entfernt man sie,
  // wird genau diese Zeile rot — auf jeder Plattform, auch auf Windows.
  const w = await laden()
  aufPlattform('darwin', () => {
    w.ruf('titelleisteFarbe', { color: '#0b0b0f', symbolColor: '#fafafa' })
  })
  assert.ok(!w.spur.some(s => s.startsWith('overlay:')),
    'macOS hat keine Overlay-Titelleiste (hiddenInset) — der Handler steigt vorher aus')
})

test('fortschritt: -1 raeumt ab, 0..1 zeigt, alles andere wird abgewiesen', async () => {
  const w = await laden()
  for (const schlecht of [2, NaN, Infinity, 'x', undefined]) await w.ruf('fortschritt', schlecht)
  assert.ok(!w.spur.some(s => s.startsWith('balken:')), '>1 waere ein Dauerbalken, der nie endet')
  await w.ruf('fortschritt', 0.5)
  await w.ruf('fortschritt', -1)
  assert.ok(w.spur.includes('balken:0.5') && w.spur.includes('balken:-1'))
})

test('nur der Modus "error" kommt durch — die Bruecke ist die Vertrauensgrenze', async () => {
  const w = await laden()
  await w.ruf('fortschritt', 0.5, 'error')
  await w.ruf('fortschritt', 0.5, 'paused')
  assert.ok(w.spur.includes('balken:0.5:error'))
  assert.strictEqual(w.spur.filter(s => s === 'balken:0.5').length, 1, 'paused faellt auf den normalen Balken')
})

// ── Protokoll oeffnen / Projekte oeffnen (#218) ───────────────────────────────
test('protokollOeffnen setzt eine Marke und zeigt die Datei', async () => {
  const w = await laden()
  const p = await w.ruf('protokollOeffnen')
  assert.strictEqual(p, '/pfad/zu/transkribor.log')
  assert.ok(w.protokollzeilen.some(z => z.includes('vom Nutzer geoeffnet')))
  assert.ok(w.spur.includes('zeigen:/pfad/zu/transkribor.log'))
})

test('projekteOeffnen fragt den SERVER und oeffnet den ORDNER (#218)', async () => {
  const w = await laden()
  const p = await w.ruf('projekteOeffnen')
  assert.strictEqual(p, '/pfad/zu/projekte')
  assert.ok(w.spur.includes('backend.projektePfad'), 'nicht P.projekte neu rechnen')
  assert.ok(w.spur.includes('openPath:/pfad/zu/projekte'))
  assert.ok(!w.spur.some(s => s.startsWith('zeigen:/pfad/zu/projekte')),
    'showItemInFolder oeffnete das ELTERNverzeichnis mit markiertem projekte')
})

test('projekteOeffnen wirft die Systemmeldung weiter, statt still nichts zu tun', async () => {
  const w = await laden({ openPathFehler: 'Zugriff verweigert' })
  await assert.rejects(() => w.ruf('projekteOeffnen'), /Zugriff verweigert/)
})

// ── Fehlerbericht (#372) ──────────────────────────────────────────────────────
test('fehlerbericht oeffnet eine mailto-URL UND zeigt die Datei daneben', async () => {
  // Beides gehoert zusammen: `mailto` kann keine Anhaenge, die vollstaendige Spur ist aber
  // genau das, was man anhaengt.
  const w = await laden()
  const r = await w.ruf('fehlerbericht')
  const mail = w.spur.find(z => z.startsWith('extern:mailto:'))
  assert.ok(mail, 'keine mailto-URL geoeffnet')
  assert.ok(w.spur.includes(`zeigen:${w.logpfad}`))
  assert.strictEqual(r.pfad, w.logpfad)
})

test('der Bericht traegt Fassung und Plattform, aber NICHT den PATH', async () => {
  const w = await laden({ logtext: 'PATH      : C:\\Windows;C:\\Users\\marcus\\bin\nirgendwas ging schief\n' })
  await w.ruf('fehlerbericht')
  const rumpf = decodeURIComponent(w.spur.find(z => z.startsWith('extern:mailto:')).split('&body=')[1])
  assert.ok(rumpf.includes('9.9.9'), 'die Fassung, sonst raet der Empfaenger')
  assert.ok(rumpf.includes(process.platform))
  assert.ok(rumpf.includes('irgendwas ging schief'), 'die Protokollzeilen gehen mit')
  assert.ok(!/PATH/i.test(rumpf),
    'der PATH traegt den Benutzernamen — er bleibt in der Datei, die der Nutzer BEWUSST anhaengt')
})

test('ein durchgerutschter Schluessel wird maskiert, bevor er in eine Mail geht', async () => {
  // Geschrieben werden die Zeilen zwar schon maskiert (#371) — eine rotierte Datei kann
  // aber aus einer Fassung davor stammen, und hier landet sie in einer Mail.
  const w = await laden({ logtext: 'FEHLER: Anthropic sagt nein, key sk-ant-abcdefghijklmnop\n' })
  await w.ruf('fehlerbericht')
  const rumpf = decodeURIComponent(w.spur.find(z => z.startsWith('extern:mailto:')).split('&body=')[1])
  assert.ok(!rumpf.includes('sk-ant-abcdefghijklmnop'))
  assert.ok(rumpf.includes('***[API-KEY]***'))
})

test('die Marke steht NACH dem Lesen — sie verdraengt keine echte Zeile', async () => {
  // Andersherum stuende „vom Nutzer erstellt" als juengste Zeile im eigenen Bericht.
  const w = await laden({ logtext: 'eine echte Zeile\n' })
  await w.ruf('fehlerbericht')
  const rumpf = decodeURIComponent(w.spur.find(z => z.startsWith('extern:mailto:')).split('&body=')[1])
  assert.ok(!rumpf.includes('Fehlerbericht vom Nutzer erstellt'))
  assert.ok(w.protokollzeilen.some(z => z.includes('Fehlerbericht vom Nutzer erstellt')),
    'in der DATEI steht sie sehr wohl')
})

test('scheitert das Oeffnen der Mail, erfaehrt es der Nutzer — und die Datei liegt trotzdem da', async () => {
  // Ohne registrierten mailto-Handler ist das der NORMALFALL, nicht der Randfall. Ohne den
  // Wurf taete der Knopf sichtbar nichts, waehrend die Seite eine Mail verspricht.
  const w = await laden({ logtext: 'zeile\n', externFehler: 'Kein Programm fuer mailto' })
  await assert.rejects(() => w.ruf('fehlerbericht'), /Kein Programm fuer mailto/)
  // Die zweite Haelfte ist die eigentliche Zusage der Reihenfolge: der Weg, der immer geht,
  // ist VORHER gegangen worden.
  assert.ok(w.spur.includes(`zeigen:${w.logpfad}`))
})

// ── Update ────────────────────────────────────────────────────────────────────
test('installieren tut nichts, solange der Download nicht fertig ist', async () => {
  const w = await laden({ updateZustand: { art: 'laedt' } })
  await w.ruf('update:installieren')
  assert.ok(!w.spur.includes('update.installieren'),
    'sonst laeuft die App mit totem Backend weiter, ohne je neu zu starten')
  assert.ok(!w.spur.includes('backend.stop'))
})

test('bei "bereit" wird das Backend VOR dem Installieren gestoppt', async () => {
  const w = await laden({ updateZustand: { art: 'bereit' } })
  await w.ruf('update:installieren')
  const stop = w.spur.indexOf('backend.stop')
  const inst = w.spur.indexOf('update.installieren')
  assert.ok(stop >= 0 && inst >= 0 && stop < inst,
    'andersherum bliebe uvicorn als Waise mit belegter GPU zurueck')
})

test('der 6-Stunden-Takt schweigt offline und wenn sollPruefen nein sagt', async () => {
  const w = await laden({ online: false })
  const vorher = w.spur.filter(s => s === 'update.pruefen').length
  w.takt()
  assert.strictEqual(w.spur.filter(s => s === 'update.pruefen').length, vorher,
    'offline gaebe es nur eine Fehlerzeile, nach der niemand gefragt hat')
  w.online = true
  w.sollPruefen = false
  w.takt()
  assert.strictEqual(w.spur.filter(s => s === 'update.pruefen').length, vorher)
  w.sollPruefen = true
  w.takt()
  assert.strictEqual(w.spur.filter(s => s === 'update.pruefen').length, vorher + 1)
  assert.ok(w.taktUnref, 'ein Hintergrund-Zeitgeber darf die App nie am Leben halten')
})

test('ein Fehler beim Update-Aufbau liefert einen ERSATZ statt null (#319)', async () => {
  const w = await laden({ erstellenWirft: true })
  assert.ok(w.protokollzeilen.some(z => z.startsWith('Update-Aufbau fehlgeschlagen:')))
  assert.ok(w.spur.includes('updater.nachFehler'),
    'null waere im Frontend nicht von „laeuft im normalen Browser" zu unterscheiden')
  assert.notStrictEqual(await w.ruf('update:status'), null)
})

test('GEPACKT ist eine unlesbare app-update.yml eine Zeile wert, im Betrieb nicht (#192)', async () => {
  const echt = process.resourcesPath
  Object.defineProperty(process, 'resourcesPath', { value: path.join(os.tmpdir(), 'gibt-es-nicht'), configurable: true })
  try {
    const gepackt = await laden({ gepackt: true })
    assert.ok(gepackt.protokollzeilen.some(z => z.startsWith('app-update.yml nicht lesbar:')))
    const roh = await laden({ gepackt: false })
    assert.ok(!roh.protokollzeilen.some(z => z.startsWith('app-update.yml nicht lesbar:')),
      'im Entwicklungsbetrieb ist ihr Fehlen der Normalfall')
  } finally {
    if (echt === undefined) delete process.resourcesPath
    else Object.defineProperty(process, 'resourcesPath', { value: echt, configurable: true })
  }
})

test('der Anfangszustand "keine-quelle" steht in der Datei — er geht nicht durch aendert', async () => {
  const w = await laden({ updateZustand: { art: 'nicht_moeglich', grund: 'keine-quelle' } })
  assert.ok(w.protokollzeilen.some(z => z.startsWith('Update-Pruefung nicht moeglich:')))
})

test('eine Fehlermeldung des Aktualisierers geht in die Datei UND ins Fenster', async () => {
  const w = await laden()
  w.aendert({ art: 'fehler', text: 'kein Netz' })
  assert.ok(w.protokollzeilen.some(z => z === 'Update-Pruefung fehlgeschlagen: kein Netz'))
  assert.ok(w.gesendet.some(g => g.kanal === 'update'))
})

// ── Lebenszyklus ─────────────────────────────────────────────────────────────
test('window-all-closed und before-quit stoppen den Server', async () => {
  const w = await laden()
  w.appEreignisse.get('window-all-closed')()
  assert.ok(w.spur.includes('backend.stop'))
  assert.strictEqual(w.quits, 1)
  const vorher = w.spur.filter(s => s === 'backend.stop').length
  w.appEreignisse.get('before-quit')()
  assert.strictEqual(w.spur.filter(s => s === 'backend.stop').length, vorher + 1)
})

test('externe Links gehen in den Browser, nicht in die App', async () => {
  const w = await laden()
  const antwort = w.oeffnenHandler({ url: 'https://example.org/doku' })
  assert.deepStrictEqual(antwort, { action: 'deny' })
  assert.ok(w.spur.includes('extern:https://example.org/doku'))
})

// Der Gegenpart, und der eigentliche Punkt von #426: geprueft wird die VERDRAHTUNG, nicht die
// reine Funktion. `./fenster` bleibt in dieser Datei absichtlich ECHT (siehe Modulkopf) — hier
// steht also, dass main.js den Waechter tatsaechlich davorhaengt, nicht nur, dass es ihn gibt.
test('ein fremdes Schema erreicht das Betriebssystem NICHT — und sagt es (#426)', async () => {
  const w = await laden()
  const antwort = w.oeffnenHandler({ url: 'file:///C:/Windows/System32/calc.exe' })
  assert.deepStrictEqual(antwort, { action: 'deny' })
  assert.ok(!w.spur.some(s => s.startsWith('extern:')),
    'shell.openExternal darf mit einer file:-URL gar nicht erst gerufen werden')
  // Stille Abweisung waere ein Link, der sichtbar nichts tut und keine Spur hinterlaesst.
  assert.ok(w.protokollzeilen.some(z => z.includes('abgewiesen') && z.includes('file:')),
    'die Abweisung gehoert ins Protokoll')
})

test('ans Betriebssystem geht die GEPRUEFTE Form, nicht die rohe (#426)', async () => {
  const w = await laden()
  // Als Zeichen gebaut statt als Escape-Folge: ein rohes NUL im Quelltext macht die Datei
  // fuer git zu einer BINAERdatei, und der Diff ist danach nicht mehr lesbar (einmal passiert).
  const NUL = String.fromCharCode(0)
  w.oeffnenHandler({ url: NUL + 'https://example.org/doku' })
  assert.ok(w.spur.includes('extern:https://example.org/doku'),
    'das Steuerzeichen darf nicht mitreisen — geprueft wurde die geparste Form')
  assert.ok(!w.spur.some(s => s.startsWith('extern:') && s.includes(NUL)))
})

// Die beiden folgenden Waechter stehen fuer einen Befund an DIESEM Fix, nicht am Bestand:
// die Protokollzeile war der erste Weg, auf dem der Renderer Text FREIER LAENGE in die Datei
// schreiben konnte, aus der `bericht.js` die Fehlerbericht-Mail baut.
test('eine ueberlange abgewiesene URL wird gedeckelt (#426)', async () => {
  const w = await laden()
  // Gemessen kommt eine window.open-URL mit bis zu 2 MB am Handler an. Ohne Deckel entleerte
  // EIN solcher Aufruf den naechsten Fehlerbericht auf "letzte 0 Protokollzeilen".
  w.oeffnenHandler({ url: 'zzz:' + 'A'.repeat(5000) })
  const zeile = w.protokollzeilen.find(z => z.includes('abgewiesen'))
  assert.ok(zeile, 'protokolliert wird sie weiterhin')
  assert.ok(zeile.length < 400, `Zeile ist ${zeile.length} Zeichen — der Deckel greift nicht`)
})

test('nach 20 Abweisungen schweigt das Protokoll — mit einer letzten Zeile (#426)', async () => {
  const w = await laden()
  // Ohne Bremse: 20 000 Aufrufe ohne Nutzergeste kamen alle an (~4200/s, kein Popup-Blocker).
  for (let i = 0; i < 50; i++) w.oeffnenHandler({ url: 'file:///x' + i })
  const abgewiesen = w.protokollzeilen.filter(z => z.startsWith('Externer Link abgewiesen'))
  assert.strictEqual(abgewiesen.length, 20, 'genau der Deckel, nicht mehr')
  const schluss = w.protokollzeilen.filter(z => z.startsWith('Weitere Abweisungen'))
  assert.strictEqual(schluss.length, 1, 'die Unterdrueckung wird EINMAL angesagt, nicht 30-mal')
  // Sie muss den Vorgang mitnennen (#506): `bericht.letzteZeilen` laesst genau EINE Zeile
  // dieser Gruppe in die Fehlermail, und im Flutfall ist das GENAU diese. Ohne Art, Grund und
  // Ziel schickt der Nutzer eine Zeile ab, aus der sich nichts rekonstruieren laesst.
  assert.match(schluss[0], /die naechste war: Externer Link, Schema nicht erlaubt, file:\/\/\/x20/)
})

// ── Navigationswaechter (#434) ───────────────────────────────────────────────
// Der Gegenpart zu #426: dort ging es um ein NEUES Fenster, hier um das bestehende, das selbst
// wegnavigiert. `./fenster` bleibt auch hier echt — geprueft wird also, dass `main.js` den
// Waechter wirklich davorhaengt, nicht nur, dass es ihn gibt.
//
// Was diese Tests NICHT koennen (dieselbe Grenze wie im Modulkopf): sie sagen nicht, ob
// Electron das Ereignis ueberhaupt feuert. Das ist an einem laufenden Fenster gemessen — alle
// vier Wege des Issues (location.href, Link ohne target, form GET und POST) feuern
// `will-navigate`, der 302-Redirect feuert `will-navigate` mit der EIGENEN und erst
// `will-redirect` mit der fremden URL.

/**
 * Ein Navigationsereignis wie Electron es liefert; zurueck kommt, ob es verhindert wurde.
 * Vorgabe ist der Normalfall (Hauptrahmen); die anderen Belegungen kommen als `ereignis`.
 *
 * **Kein Vorgabewert fuer `isMainFrame` als Parameter** — genau das hatte diese Hilfe zuerst,
 * und der Fall „das Feld fehlt ganz" war damit unpruefbar: ein ausdruecklich uebergebenes
 * `undefined` loest in JavaScript den Vorgabewert aus, der Test bekam also `true` und mass
 * nichts. Aufgefallen ist es erst an der Mutation `=== false` → `!` (blieb gruen).
 */
function navigieren(w, url, art = 'will-navigate', ereignis = { isMainFrame: true }) {
  let verhindert = false
  const hoerer = w.navHoerer.get(art)
  assert.ok(hoerer, `kein Hoerer fuer ${art} registriert`)
  // Die ECHTE Form: Details-Ereignis mit `url`/`isMainFrame` als erstes Argument, die
  // `@deprecated` positionale URL dahinter. `ereignis` darf beides ueberschreiben — nur so
  // laesst sich pruefen, aus welcher der zwei Quellen der Waechter wirklich liest.
  hoerer({ preventDefault: () => { verhindert = true }, url, ...ereignis }, url)
  return verhindert
}

test('der Navigationswaechter haengt an will-navigate UND will-redirect (#434)', async () => {
  const w = await laden()
  // Beide einzeln: nur `will-navigate` liesse den Redirect-Weg offen (gemessen), nur
  // `will-redirect` den direkten.
  assert.ok(w.navHoerer.has('will-navigate'), 'ohne will-navigate ist der direkte Weg offen')
  assert.ok(w.navHoerer.has('will-redirect'), 'ohne will-redirect landet ein 302 auf der fremden Seite')
})

test('die eigenen Herkuenfte navigieren ungehindert (#434)', async () => {
  const w = await laden()
  // Der Loopback-Server mit beliebigem Pfad — und die Statusseite, die der Nutzer mitten in
  // der Einrichtung per Ctrl+R neu laedt (dokumentierter Weg, s. electron/CLAUDE.md).
  for (const eigen of [
    'http://127.0.0.1:8000/p/Projekt/datei',
    'http://127.0.0.1:8000/',
    pathToFileURL(path.join(__dirname, 'setup.html')).href,
  ]) {
    assert.strictEqual(navigieren(w, eigen), false, `${eigen} ist die eigene App`)
  }
  assert.ok(!w.spur.some(s => s.startsWith('extern:')), 'die eigene App gehoert nicht in den Browser')
  assert.deepStrictEqual(w.protokollzeilen.filter(z => z.includes('abgewiesen')), [],
    'ein Reload der eigenen Seite ist kein Vorfall und fuellt das Protokoll nicht')
})

test('eine fremde Herkunft wird abgefangen und geht in den Browser (#434)', async () => {
  const w = await laden()
  const NUL = String.fromCharCode(0)
  assert.strictEqual(navigieren(w, `${NUL}https://example.org/doku`), true,
    'ohne preventDefault navigiert das Fenster weg — samt preload-Bruecke')
  // Wie bei #426: hinaus geht die GEPRUEFTE Form, nie die rohe Eingabe.
  assert.ok(w.spur.includes('extern:https://example.org/doku'))
  assert.ok(!w.spur.some(s => s.startsWith('extern:') && s.includes(NUL)))
})

test('ein fremdes Schema erreicht weder Fenster noch Betriebssystem (#434)', async () => {
  const w = await laden()
  assert.strictEqual(navigieren(w, 'file:///C:/Windows/System32/calc.exe'), true)
  assert.ok(!w.spur.some(s => s.startsWith('extern:')),
    'shell.openExternal darf mit einer file:-URL gar nicht erst gerufen werden')
  assert.ok(w.protokollzeilen.some(z => z.startsWith('Navigation abgewiesen') && z.includes('calc.exe')),
    'im Protokoll muss stehen, dass hier NAVIGIERT werden sollte, nicht dass ein Link aufging')
})

test('der Redirect-Weg haengt am selben Waechter — aber OHNE den Browser (#434)', async () => {
  const w = await laden()
  // Gemessen: bei einem 302 von der eigenen auf eine fremde Herkunft sieht `will-navigate` nur
  // die eigene URL. Ohne diesen Hoerer landete das Fenster auf der fremden Seite.
  assert.strictEqual(navigieren(w, 'http://127.0.0.1:8000/weiter', 'will-redirect'), false)
  assert.strictEqual(navigieren(w, 'https://example.org/ziel', 'will-redirect'), true)

  // Und hier endet die Gemeinsamkeit mit `will-navigate`: das Ziel einer Umleitung waehlt ein
  // SERVER, nicht der Nutzer. Ginge es in den Browser, genuegte eine 302 auf der eigenen
  // Herkunft, um `shell.openExternal` mit einer beliebigen fremden URL zu feuern — ohne Klick.
  assert.ok(!w.spur.some(s => s.startsWith('extern:')),
    'eine Umleitung darf den System-Browser NICHT oeffnen')
  assert.ok(w.protokollzeilen.some(z => z.startsWith('Weiterleitung abgewiesen') && z.includes('example.org')),
    'sie wird stattdessen protokolliert, und zwar als Weiterleitung — nicht als Navigation')
  // #458: `https://example.org/ziel` traegt ein ERLAUBTES Schema. Bis dahin stand unter dieser
  // Zeile trotzdem „(Schema nicht erlaubt)" — dieser Test fuhr den Fehler also die ganze Zeit
  // und behauptete nur den Zeilenanfang. Jetzt behauptet er auch den Grund.
  assert.ok(w.protokollzeilen.some(z => z.includes('(Weiterleitung folgt keinem Link)')),
    'abgewiesen wird hier, WEIL ein Server das Ziel waehlt — nicht wegen des Schemas')
})

test('die Abweisungszeile nennt den echten Grund, nicht immer das Schema (#458)', async () => {
  const w = await laden()
  // Alle drei Gruende in EINEM Test, weil der Punkt ihre UNTERSCHEIDBARKEIT ist: je einzeln
  // geprueft bliebe unbemerkt, wenn zwei davon denselben Text traegen.
  w.oeffnenHandler({ url: 'ht!tp://kaputt' })
  navigieren(w, 'javascript:alert(1)')
  navigieren(w, 'https://example.org/ziel', 'will-redirect')

  const zeile = teil => w.protokollzeilen.find(z => z.includes(teil)) || `(keine Zeile mit ${teil})`
  assert.match(zeile('kaputt'), /^Externer Link abgewiesen \(nicht lesbar\): /)
  assert.match(zeile('javascript:'), /^Navigation abgewiesen \(Schema nicht erlaubt\): /)
  assert.match(zeile('example.org'), /^Weiterleitung abgewiesen \(Weiterleitung folgt keinem Link\): /)

  const gruende = new Set(w.protokollzeilen
    .filter(z => z.includes(' abgewiesen ('))
    .map(z => z.match(/ abgewiesen \(([^)]+)\)/)[1]))
  assert.strictEqual(gruende.size, 3,
    `drei verschiedene Ablehnungen muessen drei verschiedene Gruende nennen, gesehen: ${[...gruende]}`)
})

test('der Deckel ist ein Zeitfenster, kein Lebenszeit-Budget (#448)', async () => {
  const w = await laden()
  // `performance.now` direkt gestubbt statt `mock.timers`: drei Zeilen, unabhaengig von der
  // Node-Fassung des Laeufers, und die Uhr steht nur fuer diesen Test still. Gestubbt wird
  // GENAU die Uhr, die `abweisungProtokollieren` liest — eine monotone, keine Wanduhr; wer das
  // hier auf `Date.now` zurueckdreht, misst danach eine Uhr, die die Funktion nie fragt, und
  // der Test wird gruen, ohne etwas zu pruefen.
  const echt = performance.now
  try {
    let jetzt = echt.call(performance)
    performance.now = () => jetzt
    for (let i = 0; i < 30; i++) w.oeffnenHandler({ url: 'file:///a' + i })
    assert.strictEqual(w.protokollzeilen.filter(z => z.startsWith('Externer Link abgewiesen')).length,
      20, 'innerhalb der Stunde bleibt es beim Deckel — sonst misst der Test nur, DASS etwas zuruecksetzt')
    // Die Schlusszeile muss sagen, dass der Deckel ein FENSTER ist. Ohne diese Zusicherung stand
    // „je Stunde" ungedeckt im Code (`grep "je Stunde" electron/*.test.js` war leer) — ein
    // Zusatz, den niemand rot bekommt, ist eine Behauptung, keine Zusicherung.
    assert.ok(w.protokollzeilen.some(z => z.startsWith('Weitere Abweisungen') && z.includes('je Stunde')),
      'die Schlusszeile nennt den Deckel als Stundenwert, nicht als Lebenszeit-Budget')

    jetzt += 60 * 60 * 1000 + 1
    w.oeffnenHandler({ url: 'file:///nach-einer-stunde' })
    assert.ok(w.protokollzeilen.some(z => z.includes('nach-einer-stunde')),
      'nach einer ruhigen Stunde schreibt die App wieder mit; vorher schwieg sie bis zum Neustart (#448)')
  } finally { performance.now = echt }
})

test('Fensteroeffner und Navigation teilen EINEN Deckel und EINE Bremse (#434)', async () => {
  const w = await laden()
  // Der teuerste Befund an #426 war ein ungebremster Schreibweg ins Protokoll — `bericht.mailto`
  // kuerzt von oben und entleert den naechsten Fehlerbericht still. Ein EIGENER Zaehler fuer den
  // neuen Pfad haette dieselbe Luecke wieder aufgemacht, nur halb so schnell.
  for (let i = 0; i < 15; i++) w.oeffnenHandler({ url: `file:///x${i}` })
  for (let i = 0; i < 15; i++) navigieren(w, `file:///y${i}`)
  const abgewiesen = w.protokollzeilen.filter(z => z.includes(' abgewiesen (Schema nicht erlaubt): '))
  assert.strictEqual(abgewiesen.length, 20, `30 Abweisungen ueber beide Wege ergaben ${abgewiesen.length} Zeilen — der Deckel ist nicht geteilt`)
  const schluss = w.protokollzeilen.filter(z => z.startsWith('Weitere Abweisungen'))
  assert.strictEqual(schluss.length, 1, 'die Unterdrueckung wird EINMAL angesagt, nicht je Weg einmal')
})

test('die URL kommt aus dem Details-Ereignis, nicht aus dem veralteten Argument (#434)', async () => {
  const w = await laden()
  // `electron.d.ts` markiert die positionalen Parameter von `will-navigate`/`will-redirect` als
  // `@deprecated`; zugesagt ist `details.url`. Heute liefern beide dasselbe — deshalb ist das
  // ein VERTRAGSTEST: er laesst sie auseinanderlaufen und haelt fest, welcher gilt.
  assert.strictEqual(
    navigieren(w, 'http://127.0.0.1:8000/', 'will-navigate', { isMainFrame: true, url: 'https://boese.example/' }),
    true, 'gepruefte werden muss die URL aus dem Details-Ereignis')
  assert.ok(w.spur.includes('extern:https://boese.example/'))
  assert.ok(!w.spur.some(s => s === 'extern:http://127.0.0.1:8000/'),
    'der veraltete positionale Wert darf die Entscheidung nicht tragen')
})

test('ein UNTERRAHMEN erreicht den Waechter nicht — und damit nicht den Browser (#434)', async () => {
  const w = await laden()
  // Gemessen: `will-redirect` feuert AUCH fuer iframes (`isMainFrame=false`). Ohne diese Wache
  // oeffnete ein umleitendes iframe den SYSTEM-Browser — ohne Skript, ohne Nutzergeste. Vor
  // #434 folgte der Rahmen dem Redirect einfach in sich selbst; das waere eine Faehigkeit, die
  // erst der Fix aufmacht, und zwar in genau dem Fall, den seine eigene Begruendung ausschliesst.
  assert.strictEqual(
    navigieren(w, 'https://example.org/aus-dem-iframe', 'will-redirect', { isMainFrame: false }), false,
    'der Rahmen darf seinem Redirect folgen wie vorher')
  assert.ok(!w.spur.some(s => s.startsWith('extern:')), 'ein Rahmen gibt nichts ans Betriebssystem')
  assert.deepStrictEqual(w.protokollzeilen.filter(z => z.includes('abgewiesen')), [],
    'und er zahlt auch nicht auf den geteilten Deckel ein')

  // Gegenrichtung, und sie ist der Grund fuer `=== false` statt `!`: fehlt die Angabe ganz,
  // MUSS der Waechter greifen. Ein unbekannter Wert darf eine Wache nie stillschweigend
  // abschalten — mit `!e.isMainFrame` waere hier alles durchgelaufen.
  assert.strictEqual(navigieren(w, 'https://example.org/ohne-angabe', 'will-redirect', {}), true,
    'ohne Angabe wird geprueft, nicht durchgewunken')
})

test('die eigenen Herkuenfte werden zur LAUFZEIT erfragt, nicht beim Fensterbau (#434)', async () => {
  // Der Entwurfshaken aus dem Issue. `backend.url()` steht beim Anhaengen des Hoerers noch
  // nicht fest; eine dort eingefrorene Liste truege fuer immer den Platzhalter-Port. Der
  // Schaden waere nutzersichtbar und faellt sonst erst im gepackten Lauf auf: jedes Ctrl+R auf
  // der Server-Seite gaelte als fremd — und weil `http:` erlaubt ist, wuerde die eigene
  // App-URL im SYSTEM-Browser aufgehen, statt im Fenster neu zu laden.
  const w = await laden({ status: { venv: false } })       // ohne venv startet kein Server
  assert.strictEqual(navigieren(w, 'http://127.0.0.1:8000/'), true,
    'solange kein Server laeuft, ist dieser Port fremd')

  await w.kanaele.get('einrichten')()                      // Einrichtung -> Server -> Port steht
  assert.strictEqual(w.backend.url(), 'http://127.0.0.1:8000/', 'Vorbedingung: der Port steht jetzt')
  assert.strictEqual(navigieren(w, 'http://127.0.0.1:8000/'), false,
    'dieselbe URL, dasselbe Fenster — nur eine zur Laufzeit erfragte Liste kann das')
})

test('auch die Navigations-Abweisung ist gedeckelt (#434)', async () => {
  const w = await laden()
  navigieren(w, `zzz:${'A'.repeat(5000)}`)
  const zeile = w.protokollzeilen.find(z => z.startsWith('Navigation abgewiesen'))
  assert.ok(zeile, 'protokolliert wird sie weiterhin')
  assert.ok(zeile.length < 400, `Zeile ist ${zeile.length} Zeichen — der Deckel greift auf diesem Weg nicht`)
})

// ── Berechtigungen und <webview> (#446) ──────────────────────────────────────
// Die dritte und vierte Fenster-Faehigkeit. Dieselbe Grenze wie bei #434: diese Tests sagen
// nicht, ob Chromium die Anfrage ueberhaupt stellt — dafuer gibt es den Lauf am echten
// Fenster. Sie sagen, dass `main.js` den Waechter davorhaengt und wie er urteilt.

/**
 * Ruft den Berechtigungs-Handler wie Electron und gibt zurueck, was er erlaubt hat.
 *
 * `angaben` ist der VIERTE Parameter — an einem laufenden Fenster gemessen traegt er
 * `requestingUrl` und `isMainFrame` bei den drei Anfragearten, die dort auflaufen
 * (`notifications`, `clipboard-sanitized-write`, `media`); fuer die uebrigen ist es nicht
 * gemessen, und der Handler lehnt ohne die Angabe ab. Vorgabe ist die eigene Statusseite;
 * ein Test, der die fremde Herkunft prueft, uebergibt seine eigene.
 */
const EIGENE_SEITE = pathToFileURL(path.join(__dirname, 'setup.html')).href
function berechtigungFragen(w, art, angaben = { requestingUrl: EIGENE_SEITE, isMainFrame: true }) {
  assert.ok(w.berechtigungHandler, 'kein Berechtigungs-Handler an der Session registriert')
  let erlaubt = null
  w.berechtigungHandler({}, art, ok => { erlaubt = ok }, angaben)
  return erlaubt
}

test('was die App wirklich braucht, kommt durch (#446, #376)', async () => {
  const w = await laden()
  // Beide am LAUFENDEN Fenster gemessen, nicht aus dem Code geschlossen: `notifications` fuer
  // die Fertigmeldung (#376, `useOsFortschritt.ts`) und `clipboard-sanitized-write` fuer
  // „Lizenzschluessel kopieren" (`SettingsPage.tsx`). Die zweite lief entgegen der Annahme des
  // Plans durch den REQUEST-Handler — ein Deny-all haette den Knopf still abgeschaltet.
  assert.strictEqual(berechtigungFragen(w, 'notifications'), true)
  assert.strictEqual(berechtigungFragen(w, 'clipboard-sanitized-write'), true)
  assert.deepStrictEqual(w.protokollzeilen.filter(z => z.startsWith('Berechtigung abgewiesen')), [],
    'was erlaubt ist, ist kein Vorfall und fuellt das Protokoll nicht')
})

test('jede andere Berechtigung wird abgelehnt UND protokolliert (#446)', async () => {
  const w = await laden()
  // Die App fragt heute keine davon an. Ohne Handler entschiede Chromiums Voreinstellung —
  // eine Injektion koennte einen Systemdialog ausloesen, den der Nutzer fuer die App haelt.
  // `clipboard-read` steht bewusst dabei: die App schreibt in die Zwischenablage, sie liest
  // nie daraus. Ohne diesen Fall bestuende die Weissliste auch als „alles mit clipboard".
  const verboten = ['media', 'geolocation', 'midi', 'pointerLock', 'display-capture', 'clipboard-read']
  for (const art of verboten) {
    assert.strictEqual(berechtigungFragen(w, art), false, `${art} gehoert nicht durch`)
  }
  const zeilen = w.protokollzeilen.filter(z => z.startsWith('Berechtigung abgewiesen'))
  assert.strictEqual(zeilen.length, verboten.length,
    'still abgelehnt waere schlimmer als gar nicht abgelehnt')
  assert.ok(zeilen[0].includes('media'), 'im Protokoll muss stehen, WELCHE Berechtigung')
})

test('eine FREMDE Herkunft bekommt auch die erlaubten Rechte nicht (#446)', async () => {
  const w = await laden()
  // Die Weissliste allein reichte nicht: sie fragt WAS, nicht WER. Dieselbe Liste und
  // dieselbe Laufzeit-Abfrage wie bei den Navigationswachen (#434).
  for (const art of ['notifications', 'clipboard-sanitized-write']) {
    assert.strictEqual(berechtigungFragen(w, art, { requestingUrl: 'https://boese.example/x' }), false,
      `${art} ist erlaubt — aber nicht fuer eine fremde Seite`)
  }
  assert.ok(w.protokollzeilen.some(z =>
    z.startsWith('Berechtigung abgewiesen (fremde Herkunft)') && z.includes('boese.example')),
  'im Protokoll muss stehen, WER gefragt hat — sonst sagt „media abgelehnt" nichts')
  // Fehlt die Angabe ganz, wird abgelehnt: ein unbekannter Wert schaltet keine Wache ab (#266).
  assert.strictEqual(berechtigungFragen(w, 'notifications', {}), false)
})

test('von einer fremden URL geht nur die HERKUNFT ins Protokoll (#446, Bot an PR #522)', async () => {
  const w = await laden()
  // Benutzerteil, Pfad, Query und Fragment tragen hier nichts bei — koennen aber ein Token oder
  // einen OAuth-Code fuehren, und die Zeile faehrt ueber `bericht.letzteZeilen` in eine Mail.
  //
  // **Der Fixture-Wert ist absichtlich KEIN Zugangsdaten-Muster** (Benutzerteil ohne Kennwort,
  // harmloser Abfrageparameter). Mit einem echten `benutzer:kennwort@` schlug der
  // Geheimnis-Scanner am PR an — GitGuardian meldete „1 secret uncovered", und ein Wecker, der
  // bei Testdaten laeutet, wird weggeklickt. Geprueft ist derselbe Mechanismus: `origin`
  // schneidet ALLES ausser Schema, Host und Port ab, gleich was darin stand.
  berechtigungFragen(w, 'media',
    { requestingUrl: 'https://gast@boese.example:8443/pfad?sitzung=beispiel#frag' })
  const zeile = w.protokollzeilen.find(z => z.startsWith('Berechtigung abgewiesen (fremde Herkunft)'))
  assert.ok(zeile.includes('https://boese.example:8443'), `Herkunft fehlt: ${zeile}`)
  for (const weg of ['gast@', 'sitzung=beispiel', '/pfad', '#frag']) {
    assert.ok(!zeile.includes(weg), `${weg} gehoert nicht ins Protokoll: ${zeile}`)
  }
  // Auch der webview-Weg, und beide Randfaelle: `file:` hat gar keine Herkunft (`origin`
  // waere die Zeichenkette 'null'), Unlesbares wird benannt statt verschwiegen.
  const hoerer = w.navHoerer.get('will-attach-webview')
  hoerer({ preventDefault: () => {} }, {}, { src: 'file:///C:/Users/marcu/Videos/Interview.mp3' })
  hoerer({ preventDefault: () => {} }, {}, { src: 'kein=url' })
  const webview = w.protokollzeilen.filter(z => z.startsWith('Eingebettete Ansicht abgewiesen'))
  assert.ok(webview[0].endsWith('file:'), `Schema statt Pfad erwartet: ${webview[0]}`)
  assert.ok(!webview[0].includes('Interview'), 'der Aufnahmename gehoert nicht in die Zeile')
  assert.ok(webview[1].includes('(unlesbare Herkunft)'), `benannt statt leer: ${webview[1]}`)
})

test('ein <webview> kommt gar nicht erst zustande (#446)', async () => {
  const w = await laden()
  const hoerer = w.navHoerer.get('will-attach-webview')
  assert.ok(hoerer, 'ohne Hoerer darf ein <webview> eigene webPreferences mitbringen')
  let verhindert = false
  hoerer({ preventDefault: () => { verhindert = true } }, {}, { src: 'https://boese.example/x' })
  assert.ok(verhindert, 'das ist der einzige Weg zu einem Kontext MIT preload in diesem Fenster')
  assert.ok(w.protokollzeilen.some(z =>
    z.startsWith('Eingebettete Ansicht abgewiesen') && z.includes('boese.example')),
  'sonst tut die Seite sichtbar nichts und niemand findet den Grund')
})

test('Berechtigungen teilen den Deckel der Linkabweisungen (#446, #426)', async () => {
  const w = await laden()
  // Ein zweiter, eigener Schreibweg waere genau der Fehler aus #426: ein Renderer, der beide
  // Wege abwechselnd flutet, haette sonst den doppelten Deckel.
  for (let i = 0; i < 15; i++) berechtigungFragen(w, 'media')
  for (let i = 0; i < 15; i++) w.oeffnenHandler({ url: 'file:///x' + i })
  const abgewiesen = w.protokollzeilen.filter(z => z.includes(' abgewiesen ('))
  assert.strictEqual(abgewiesen.length, 20, 'EIN geteilter Deckel, nicht zwei mal 20')
})

// ── Berechtigungs-PRUEFUNGEN (#518) ──────────────────────────────────────────
// Der Gegenpart zum Handler oben: er beantwortet `navigator.permissions.query(...)` und laeuft
// bei jedem Lesen von `Notification.permission` mit. Andere Signatur (Rueckgabewert statt
// Rueckruf), dritter Parameter ist die HERKUNFT als Zeichenkette, vierter die Angaben.

/** Ruft den Check-Handler wie Electron und gibt zurueck, was er geantwortet hat. */
function pruefungFragen(w, art, angaben = { requestingUrl: EIGENE_SEITE, isMainFrame: true },
  herkunft = 'file:///') {
  assert.ok(w.berechtigungPruefer, 'kein Check-Handler an der Session registriert')
  return w.berechtigungPruefer({}, art, herkunft, angaben)
}
const pruefzeilen = w => w.protokollzeilen.filter(z => z.startsWith('Berechtigungspruefung abgewiesen'))

test('die Pruefung laesst genau das durch, was die App braucht (#518)', async () => {
  const w = await laden()
  // Am laufenden Fenster gemessen: das blosse LESEN von `Notification.permission` laeuft durch
  // diesen Handler, und `useOsFortschritt.ts` liest es vor jeder Fertigmeldung. Ein Deny-all
  // haette die Fertigmeldung abgeschaltet, ohne dass ein Request-Handler je gefragt worden waere.
  assert.strictEqual(pruefungFragen(w, 'notifications'), true)
  assert.strictEqual(pruefungFragen(w, 'clipboard-sanitized-write'), true)
  assert.deepStrictEqual(pruefzeilen(w), [], 'was erlaubt ist, ist kein Vorfall')
})

test('alles andere wird abgelehnt — auch was die Typdeklaration nicht kennt (#518)', async () => {
  const w = await laden()
  // Die ersten vier stehen in der Check-Union von `electron.d.ts`, die letzten drei NICHT —
  // und trotzdem sind sie am laufenden Fenster aufgelaufen. Eine Weissliste aus der
  // Typdeklaration waere eine Liste ueber einen Teil der Wirklichkeit; abgelehnt wird deshalb,
  // was nicht dasteht, nicht was dort verboten ist.
  const verboten = ['media', 'geolocation', 'clipboard-read', 'storage-access',
    'web-app-installation', 'window-management', 'screen-wake-lock']
  for (const art of verboten) {
    assert.strictEqual(pruefungFragen(w, art), false, `${art} gehoert nicht durch`)
  }
  assert.strictEqual(pruefzeilen(w).length, verboten.length)
  assert.ok(pruefzeilen(w)[0].includes('media'), 'im Protokoll muss stehen, WELCHE Pruefung')
})

test('je Art nur EINE Zeile — sonst frisst die Pruefung den Fehlerbericht (#518, #506)', async () => {
  const w = await laden()
  // Gemessen kamen auf 18 Anfragen 111 Pruefungen. Ungebremst waere der gemeinsame Deckel
  // (#426) nach Sekunden voll — und der entscheidet, was von einer Fehlermail uebrig bleibt.
  for (let i = 0; i < 40; i++) pruefungFragen(w, 'media')
  for (let i = 0; i < 40; i++) pruefungFragen(w, 'geolocation')
  assert.deepStrictEqual(pruefzeilen(w).length, 2, '80 Pruefungen, zwei Arten, zwei Zeilen')
  // Der Deckel bleibt trotzdem geteilt: die Pruefung schreibt ueber denselben Zaehler.
  for (let i = 0; i < 25; i++) w.oeffnenHandler({ url: 'file:///x' + i })
  assert.strictEqual(w.protokollzeilen.filter(z => z.includes(' abgewiesen (')).length, 20)
})

test('eine fremde Herkunft bekommt auch die erlaubten Rechte nicht (#518)', async () => {
  const w = await laden()
  for (const art of ['notifications', 'clipboard-sanitized-write']) {
    assert.strictEqual(pruefungFragen(w, art, { requestingUrl: 'https://boese.example/x' }), false,
      `${art} ist erlaubt — aber nicht fuer eine fremde Seite`)
  }
  assert.ok(pruefzeilen(w).some(z => z.includes('fremde Herkunft') && z.includes('boese.example')))
})

test('eine leere requestingUrl genuegt nicht — auch nicht mit eigener Herkunft daneben (#518)', async () => {
  const w = await laden()
  // Electron 43 liefert den Schluessel IMMER, leer wenn unbekannt — die Typdeklaration
  // behauptet etwas anderes („not provided for cross-origin sub frames"), gemessen kommt er
  // dort sogar mit voller URL. Entschieden wird trotzdem an ihm: `file:///` als Herkunft kann
  // die Statusseite von keiner anderen lokalen Datei unterscheiden. Wer die Herkunft hilfsweise
  // fuer die ENTSCHEIDUNG heranzieht, laesst eine leere Angabe durch, sobald sie passt — und
  // genau diese Zusicherung fehlte, bis der kalte Leser sie gemessen hat.
  assert.strictEqual(pruefungFragen(w, 'notifications', { requestingUrl: '', isMainFrame: false },
    'http://127.0.0.1:8000/'), false, 'die eigene Herkunft ersetzt die fehlende Angabe NICHT')
  assert.strictEqual(pruefungFragen(w, 'media', { requestingUrl: '' }), false)
  // Fuers PROTOKOLL darf die Herkunft einspringen — dort geht es nur um „wer hat gefragt".
  pruefungFragen(w, 'midi', { requestingUrl: '' }, 'https://boese.example')
  const zeile = pruefzeilen(w).find(z => z.includes('boese.example'))
  assert.ok(zeile, `Herkunft fehlt in: ${pruefzeilen(w).join(' | ')}`)
  // Aber NICHT als „fremde Herkunft": das Startdokument eines Unterrahmens kommt ohne
  // `requestingUrl` und mit der Herkunft des ELTERN — also unserer eigenen. Das Etikett
  // „fremd" waere dort gelogen (an einer Rahmen-Sonde gemessen).
  assert.match(zeile, /ohne Seitenangabe/, `falsches Etikett: ${zeile}`)
})

test('Chromiums Vorab-Pruefungen ohne Frager melden nichts — und verdecken den echten Fall nicht (#518)', async () => {
  const w = await laden()
  // Bei JEDEM Seitenladen prueft Chromium viermal von sich aus, mit leerer Herkunft UND leerer
  // `requestingUrl` (gemessen: `media` zweimal, `web-app-installation`, `geolocation`). Als
  // Zeile waere das ein falsches Etikett — gefragt hat niemand — und es kostete drei der
  // zwanzig Deckelplaetze bei jedem App-Start.
  for (const art of ['media', 'web-app-installation', 'geolocation']) {
    assert.strictEqual(pruefungFragen(w, art, { requestingUrl: '' }, ''), false, `${art} bleibt abgelehnt`)
  }
  assert.deepStrictEqual(pruefzeilen(w), [], 'ohne Frager gibt es nichts zu melden')
  // Der schwerere Teil: die Merkliste zaehlt je Art — haetten die Vorab-Pruefungen sie
  // gefuellt, waere die ECHTE fremde Anfrage danach nie im Protokoll gelandet.
  pruefungFragen(w, 'media', { requestingUrl: 'https://boese.example/x' })
  assert.ok(pruefzeilen(w).some(z => z.includes('boese.example')),
    `der echte Fall fehlt: ${pruefzeilen(w).join(' | ')}`)
  // Und eine eigene Abweisung derselben Art ist ein zweiter Vorgang, kein Doppel.
  pruefungFragen(w, 'media')
  assert.strictEqual(pruefzeilen(w).length, 2, 'eigen und fremd sind zwei Zeilen, nicht eine')
})

test('HTTP/2 wird abgeschaltet, BEVOR irgendetwas laeuft (#150)', async () => {
  const w = await laden()
  assert.strictEqual(w.spur[0], 'schalter:disable-http2',
    'nach dem ready-Event waere der Schalter wirkungslos')
})

// ── Opt-in Fehlerberichte (#530) ──────────────────────────────────────────────
/** Erst NACH `laden()` anfordern: beim Auswerten der Datei ist `welt` noch null, und dann
 *  zoege `./fehlerberichte` ueber `./protokoll` und `./paths` das ECHTE electron — unter
 *  node nur ein Pfad, `app.getPath` wirft. Der Cache haelt danach die attrappierte Fassung. */
const fb = () => require('./fehlerberichte')
/** Die Nachfrage haengt an einem nicht abgewarteten Versprechen hinter `serverStarten` —
 *  ein Makrotask reicht, damit Dialog und Datei durch sind. */
const kurzWarten = () => new Promise(r => setImmediate(r))

test('das SDK wird VOR whenReady initialisiert und ist ohne DSN aus', async () => {
  const w = await laden()
  assert.ok(w.sentryOptionen, 'init wurde nicht gerufen')
  assert.strictEqual(w.sentryVorReady, true, 'init muss vor dem whenReady-Abonnement laufen')
  assert.strictEqual(w.sentryVorSchalter, true, 'init muss vor appendSwitch stehen — vor allem anderen')
  assert.strictEqual(w.sentryOptionen.ipcMode, 1, 'IPCMode.Classic: kein sentry-ipc://-Schema ohne Renderer-SDK')
  assert.strictEqual(w.sentryOptionen.enabled, false, 'die package.json des Repos traegt keinen DSN')
  assert.strictEqual(w.sentryOptionen.release, 'transkribor@9.9.9')
  assert.strictEqual(w.sentryOptionen.environment, 'dev')
  assert.strictEqual(w.sentryOptionen.sendDefaultPii, false)
})

test('beim ersten Start fragt das Fenster genau einmal — Ja schaltet an, und die Antwort steht in der Datei', async () => {
  const w = await laden({ antwort: 0 })
  await kurzWarten()
  assert.strictEqual(w.dialoge.length, 1, 'genau eine Nachfrage')
  assert.strictEqual(w.dialoge[0].buttons[0], fb().FENSTER.ja)
  assert.strictEqual(w.dialoge[0].cancelId, 1, 'Schliessen heisst Nein')
  assert.strictEqual(w.dialoge[0].defaultId, 1, 'Enter heisst Nein — opt-in bleibt eine Entscheidung')
  const z = fb().lesen(fb().pfad(w.daten))
  assert.strictEqual(z.automatisch, true)
  assert.ok(z.gefragt, 'gefragt ist gesetzt')
  assert.ok(w.protokollzeilen.some(l => l.includes('Fehlerberichte automatisch: an')))
})

test('Nein bleibt aus — und ein zweiter Start mit derselben Ablage fragt nicht mehr', async () => {
  const w1 = await laden({ antwort: 1 })
  await kurzWarten()
  assert.strictEqual(w1.dialoge.length, 1)
  assert.strictEqual(fb().lesen(fb().pfad(w1.daten)).automatisch, false)
  const w2 = await laden({ daten: w1.daten, antwort: 0 })
  await kurzWarten()
  assert.strictEqual(w2.dialoge.length, 0, 'einmal gefragt ist gefragt')
  assert.strictEqual(fb().lesen(fb().pfad(w2.daten)).automatisch, false, 'die Antwort bleibt')
})

test('fehlerberichte:status und :setzen — nur ein echtes true schaltet an', async () => {
  const w = await laden({ antwort: 1 })
  await kurzWarten()
  assert.strictEqual((await w.ruf('fehlerberichte:status')).automatisch, false)
  assert.strictEqual((await w.ruf('fehlerberichte:setzen', true)).automatisch, true)
  assert.strictEqual((await w.ruf('fehlerberichte:status')).automatisch, true)
  assert.strictEqual((await w.ruf('fehlerberichte:setzen', 'ja')).automatisch, false, 'ein String ist kein Ja')
  assert.strictEqual((await w.ruf('fehlerberichte:setzen', 1)).automatisch, false, 'eine Zahl auch nicht')
  assert.ok(w.protokollzeilen.some(l => l.includes('Fehlerberichte automatisch: an')))
})

test('der Server bekommt DSN, Fassung und den Pfad der Schalterdatei mit', async () => {
  const w = await laden()
  assert.deepStrictEqual(w.startExtras, {
    bugsinkDsn: '', version: '9.9.9', fehlerberichte: path.join(w.daten, fb().DATEI),
  })
})

test('nach dem Serverstart wird die Projekte-Wurzel beim SERVER erfragt — fuer die Namensmaske (#218)', async () => {
  const w = await laden()
  await kurzWarten()
  assert.ok(w.spur.includes('backend.projektePfad'), 'die .env darf TRANSKRIBOR_PROJEKTE ueberschreiben')
  assert.ok(w.spur.indexOf('backend.start') < w.spur.indexOf('backend.projektePfad'))
})

test('before-quit schliesst das SDK, nachdem der Server steht', async () => {
  const w = await laden()
  w.appEreignisse.get('before-quit')()
  assert.ok(w.spur.includes('sentry.close'))
  assert.ok(w.spur.indexOf('backend.stop') < w.spur.indexOf('sentry.close'))
})

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

// Die gerade geladene Welt — der `Module._load`-Patch steht global, die Attrappen wechseln.
let welt = null

const echtesLaden = Module._load
Module._load = (req, ...rest) => {
  if (!welt) return echtesLaden(req, ...rest)
  if (req === 'electron') return welt.electron
  if (req === 'electron-updater') return welt.electronUpdater
  if (req === './backend') return welt.backend
  if (req === './setup') return welt.setup
  if (req === './protokoll') return welt.protokoll
  if (req === './updater') return welt.updater
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
      },
    }
    return scheibe
  }

  w.electron = {
    app: {
      isPackaged: !!opt.gepackt,
      commandLine: { appendSwitch: s => w.spur.push(`schalter:${s}`) },
      getPath: () => os.tmpdir(),
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
      openExternal: u => w.spur.push(`extern:${u}`),
    },
    nativeTheme: { shouldUseDarkColors: !!opt.dunkel },
    net: { isOnline: () => w.online },
  }
  w.electronUpdater = { autoUpdater: {} }
  w.backend = {
    start: onLine => {
      w.spur.push('backend.start')
      if (opt.logZeile) onLine(opt.logZeile)
      return w.startFehler ? Promise.reject(w.startFehler) : Promise.resolve()
    },
    stop: () => w.spur.push('backend.stop'),
    url: () => 'http://127.0.0.1:8000/',
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
  if (opt.logtext !== undefined) fs.writeFileSync(logpfad, opt.logtext)
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

test.after(() => { Module._load = echtesLaden })

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
  assert.ok(w.protokollzeilen.includes('uvicorn laeuft'))
  const kanaeleAnDenRenderer = w.gesendet.map(g => g.kanal)
  assert.ok(kanaeleAnDenRenderer.includes('phase') && kanaeleAnDenRenderer.includes('status'),
    'beides geht sehr wohl ins FENSTER')
  // ERSCHOEPFEND, nicht „enthaelt nicht": hier stand zuerst eine Suche nach dem Wortlaut der
  // Phase — und die blieb gruen, als die Mutation JEDEN Kanal mitschrieb, weil ein Objekt
  // als `[object Object]` landet und nach nichts aussieht, wonach man sucht.
  assert.deepStrictEqual(w.protokollzeilen, ['uvicorn laeuft'],
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

// ── Die beiden Kanaele mit Nutzlast vom Renderer (Vertrauensgrenze) ───────────
test('titelleisteFarbe reicht nur geprueftes Hex durch', async () => {
  const w = await laden()
  await w.ruf('titelleisteFarbe', null)
  await w.ruf('titelleisteFarbe', { color: 'red', symbolColor: '#FAFAFA' })
  assert.ok(!w.spur.some(s => s.startsWith('overlay:')), 'ungeprueft wirft `f.color` bei null')
  await w.ruf('titelleisteFarbe', { color: '#0b0b0f', symbolColor: '#fafafa' })
  assert.ok(w.spur.includes('overlay:#0b0b0f/#fafafa/40'), 'die Hoehe kommt aus fenster.js')
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

test('HTTP/2 wird abgeschaltet, BEVOR irgendetwas laeuft (#150)', async () => {
  const w = await laden()
  assert.strictEqual(w.spur[0], 'schalter:disable-http2',
    'nach dem ready-Event waere der Schalter wirkungslos')
})

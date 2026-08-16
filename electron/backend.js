'use strict'
/**
 * Der uvicorn-Prozess — das, was webtool.ps1 in seiner letzten Zeile tat, plus die drei Dinge,
 * die dort fehlten: einen freien Port suchen, auf "Server ist da" warten (statt den Browser
 * ins Leere zu schicken) und beim Beenden den ganzen Prozessbaum mitnehmen.
 */
const { spawn } = require('child_process')
const fs = require('fs')
const http = require('http')
const net = require('net')
const P = require('./paths')
const S = require('./setup')

let proc = null
let port = 0
const log = []                    // letzte Zeilen, damit ein Absturz erklaerbar bleibt

function freierPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
  })
}

/**
 * Die Umgebung des Servers — reine Funktion, damit die Entscheidung ohne laufendes Electron
 * pruefbar ist (Muster wie `setup.plan` und `fenster.fensterOptionen`).
 *
 * `exe` ist das Electron-Binary (`process.execPath`, gepackt also Transkribor.exe bzw.
 * Transkribor.app/Contents/MacOS/Transkribor).
 */
function serverEnv(exe = process.execPath) {
  return {
    // spawnEnv statt process.env: auf macOS steht Homebrew sonst nicht im PATH des
    // Servers — und jeder Job erbt diese Umgebung (jobs.py startet mit {**os.environ}).
    // Ohne das findet llm.available()s shutil.which("claude") ein installiertes Claude
    // Code nicht und meldet dem Nutzer "nicht installiert".
    ...S.spawnEnv(),
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    // Die .env parst der Server selbst (webtool/settings.py:load_env) — hier nur noch
    // sagen, WO sie liegt: gepackt in userData, im Repo neben webtool.ps1.
    TRANSKRIBOR_ENV: P.envDatei,
    // Nutzerdaten liegen nie neben der .exe — Program Files ist schreibgeschuetzt und
    // wird beim Update ersetzt.
    TRANSKRIBOR_PROJEKTE: P.projekte,
    // Dasselbe fuer die GGML-Modelle der Apple-Silicon-Engine (webtool/whispercpp.py):
    // sie werden zur Laufzeit geladen, gehoeren also zu den Nutzerdaten, nicht zum Paket.
    TRANSKRIBOR_GGML: P.ggml,
    // YouTube verlangt eine geloeste Signatur, dafuer braucht yt-dlp eine JS-Laufzeit —
    // und die gepackte App hatte weder node noch deno (#171), womit der URL-Import dort
    // bei 403 blieb. Sie bringt aber eine MIT: mit ELECTRON_RUN_AS_NODE=1 ist dasselbe
    // Binary ein gewoehnliches Node (gemessen: v24, und yt-dlps Aufruf `--permission -`
    // mit dem Skript auf stdin liefert sauberes JSON). Kein Download, alle drei Plattformen.
    //
    // Das Flag selbst steht bewusst NICHT hier, sondern in `fetch.download_one`: hier landete
    // es in der Umgebung des Servers, und `jobs.py` reicht die an jeden Subprozess weiter —
    // gebraucht wird es nur von dem einen node-Aufruf, den yt-dlp startet.
    TRANSKRIBOR_JS_RUNTIME: exe,
  }
}

function erreichbar(p) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: p, path: '/api/projects', timeout: 1000 },
      res => { res.resume(); resolve(res.statusCode === 200) })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

/** Startet den Server und loest erst auf, wenn er antwortet. */
async function start(onLine) {
  port = await freierPort()
  const merke = z => { log.push(z); if (log.length > 200) log.shift(); onLine && onLine(z) }
  proc = spawn(P.venvPython(P.venv),
    ['-m', 'uvicorn', 'webtool.app:app', '--host', '127.0.0.1', '--port', String(port)],
    {
      cwd: P.pyRoot,
      windowsHide: true,
      env: serverEnv(),
    })
  proc.stdout.on('data', b => String(b).split(/\r?\n/).filter(Boolean).forEach(merke))
  proc.stderr.on('data', b => String(b).split(/\r?\n/).filter(Boolean).forEach(merke))
  proc.on('exit', code => merke(`Server beendet (Code ${code})`))

  fs.mkdirSync(P.projekte, { recursive: true })
  for (let i = 0; i < 120; i++) {                 // 60s: der erste Import zieht fastapi+pydantic
    if (proc.exitCode !== null) throw new Error(`Server startete nicht:\n${log.slice(-15).join('\n')}`)
    if (await erreichbar(port)) return port
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`Server antwortet nicht auf Port ${port}:\n${log.slice(-15).join('\n')}`)
}

function stop() {
  if (!proc || proc.exitCode !== null) return
  if (process.platform === 'win32') {
    // /T killt den Baum: uvicorn -> transcribe.py/claude. Ein blosses kill() liesse die
    // Job-Subprozesse als Waisen mit belegter GPU zurueck (vgl. webtool/jobs.py).
    spawn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { windowsHide: true })
  } else {
    proc.kill('SIGTERM')
  }
  proc = null
}

function url() {
  return `http://127.0.0.1:${port}/`
}

/**
 * Wo die Projekte WIRKLICH liegen — gefragt wird der Server, nicht `P.projekte` (#218).
 *
 * Der naheliegende Weg waere `P.projekte`, und er ist falsch: `serverEnv()` reicht den Wert
 * zwar als `TRANSKRIBOR_PROJEKTE` hinein, aber `settings.load_env()` darf ihn aus der `.env`
 * **ueberschreiben** — die Datei gewinnt dort ausdruecklich gegen eine gesetzte Variable
 * (`webtool/settings.py`, unbedingtes `os.environ[k] = …`). Mit einer `.env`, die den
 * Schluessel setzt, oeffnete „Ordner oeffnen" also einen ANDEREN Ordner als die Seite nennt,
 * und zwar **still**: `start()` legt `P.projekte` bei jedem Lauf an (Zeile 91), `shell.openPath`
 * findet ihn also vor und meldet keinen Fehler. Bei einer Funktion, deren Zweck „hier liegen
 * deine Dateien, sichere sie" ist, ist das der schlimmstmoegliche Ausgang.
 *
 * **Kein Rueckfall auf `P.projekte` im Fehlerfall** — der waere genau diese stille Divergenz.
 * Wer den Knopf sieht, hat die Seite von diesem Server bekommen; antwortet er nicht mehr, ist
 * eine Fehlermeldung die ehrliche Auskunft.
 *
 * `basis` ist der Testsaum (Muster wie `serverEnv(exe)`): der Port ist Modulzustand, den ein
 * Test nicht setzen kann, ohne einen echten uvicorn zu starten.
 */
// Absolute Obergrenze fuer die Abfrage. **Grosszuegiger als sie aussieht, und das ist noetig:**
// `GET /api/settings` ruft `llm.available()`, das bei den Abo-CLIs einen Subprozess startet —
// gedeckelt durch `auth.STATUS_TIMEOUT` von 30 s. Eine kuerzere Frist (5 s waeren naheliegend)
// wuerde den Knopf ausgerechnet dann abwuergen, wenn der Endpunkt legitim langsam ist, und der
// Nutzer saehe einen Fehler, obwohl nichts kaputt ist. 35 s liegen darueber; alles jenseits
// davon ist ein echter Haenger.
const PFAD_TIMEOUT_MS = 35_000

function projektePfad(basis = url()) {
  return new Promise((resolve, reject) => {
    // `http.get` hat KEINE Frist — antwortet der Server gar nicht oder nur halb, bliebe das
    // Promise fuer immer offen und der Knopf drehte ohne Toast. Ein Haenger ist schlimmer als
    // eine Ausnahme: kein `catch` beim Aufrufer faengt ihn (dieselbe Regel wie in sperre.py).
    // Die `timeout`-Option deckte nur Leerlauf auf der Verbindung, nicht die Gesamtdauer.
    let fertig = false
    const uhr = setTimeout(() => {
      anfrage.destroy(new Error(`keine Antwort binnen ${PFAD_TIMEOUT_MS / 1000} s`))
    }, PFAD_TIMEOUT_MS)
    const beenden = (fn, wert) => {
      if (fertig) return
      fertig = true
      clearTimeout(uhr)
      fn(wert)
    }

    const anfrage = http.get(new URL('api/settings', basis), res => {
      if (res.statusCode !== 200) {
        res.resume()
        return beenden(reject, new Error(`Der Server antwortet mit ${res.statusCode}.`))
      }
      let roh = ''
      res.setEncoding('utf8')
      res.on('data', d => { roh += d })
      res.on('end', () => {
        let pfad
        try {
          pfad = JSON.parse(roh).projekte_pfad
        } catch (e) {
          return beenden(reject, new Error(`Antwort des Servers nicht lesbar: ${e.message}`))
        }
        pfad
          ? beenden(resolve, pfad)
          : beenden(reject, new Error('Der Server nennt keinen Projektordner.'))
      })
    })
    anfrage.on('error', e => beenden(reject, new Error(`Server nicht erreichbar: ${e.message}`)))
  })
}

module.exports = { start, stop, serverEnv, url, projektePfad, log: () => log.slice() }

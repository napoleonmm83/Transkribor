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

module.exports = { start, stop, serverEnv,
                   url: () => `http://127.0.0.1:${port}/`, log: () => log.slice() }

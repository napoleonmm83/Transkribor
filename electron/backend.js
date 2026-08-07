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

let proc = null
let port = 0
const log = []                    // letzte Zeilen, damit ein Absturz erklaerbar bleibt

/** .env laden wie webtool.ps1: KEY=VALUE, # ignorieren, Anfuehrungszeichen abstreifen. */
function envDatei() {
  const out = {}
  try {
    for (const zeile of fs.readFileSync(P.envDatei, 'utf8').split(/\r?\n/)) {
      const t = zeile.trim()
      if (!t || t.startsWith('#')) continue
      const i = t.indexOf('=')
      if (i < 1) continue
      out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '')
    }
  } catch { /* keine .env ist der Normalfall */ }
  return out
}

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
      env: {
        ...process.env,
        ...envDatei(),
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
        // Nutzerdaten liegen nie neben der .exe — Program Files ist schreibgeschuetzt und
        // wird beim Update ersetzt.
        TRANSKRIBOR_PROJEKTE: P.projekte,
      },
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

module.exports = { start, stop, url: () => `http://127.0.0.1:${port}/`, log: () => log.slice() }

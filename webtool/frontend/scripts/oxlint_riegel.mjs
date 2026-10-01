// T-006: Eingefrorener Altbestand; neue Befunde und unvollstaendige Laeufe blockieren.
// Baseline bewusst nur auf ausdruecklichen Aufruf schreiben, niemals im CI-Vergleich.
// INTENTIONAL-UNTESTED: falscher Alarm des Charakterisierungs-Gates — gepinnt durch scripts/oxlint_riegel.node-test.mjs (importiert run/compare/readBaseline/normalizeReport), das Gate kennt die Endung .node-test.mjs nicht.
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const baselineName = '.oxlint-baseline.json'
const identity = entry => JSON.stringify([
  entry.file, entry.rule, entry.severity, entry.message, entry.anchors,
])
function relativeFile(filename) {
  if (typeof filename !== 'string' || !filename) throw new Error('Dateiname fehlt')
  const file = filename.replaceAll('\\', '/')
  if (file.startsWith('/') || /^[A-Za-z]:/.test(file) ||
      file.split('/').some(part => !part || part === '..' || part === '.')) {
    throw new Error(`Kein relativer Quellpfad: ${file}`)
  }
  return file
}
function validateEntry(entry) {
  if (!entry || relativeFile(entry.file) !== entry.file ||
      !['warning', 'error'].includes(entry.severity) ||
      typeof entry.rule !== 'string' || !entry.rule ||
      typeof entry.message !== 'string' || !entry.message ||
      !Array.isArray(entry.anchors) || !entry.anchors.length ||
      entry.anchors.some(anchor => typeof anchor !== 'string' || !anchor) ||
      !Number.isSafeInteger(entry.count) || entry.count <= 0) {
    throw new Error('Ungueltiger Baseline-Eintrag')
  }
}

/** Oxlint-Spans sind UTF-8-Bytepositionen. Quelltextanker bleiben bei CRLF und
 *  vorangestellten Leer-/Kommentarzeilen gleich. Frueherer Quellkontext gilt
 *  konservativ als neuer Kontext, damit gleiche Warnungen nicht wandern. */
export function normalizeReport(report, root) {
  if (!report || !Number.isSafeInteger(report.number_of_files) || report.number_of_files <= 0 ||
      !Array.isArray(report.diagnostics)) throw new Error('Kein vollstaendiger oxlint-Lauf')
  const entries = new Map()
  const sources = new Map()
  for (const diagnostic of report.diagnostics) {
    const file = relativeFile(diagnostic.filename)
    if (!sources.has(file)) sources.set(file, readFileSync(join(root, file)))
    const source = sources.get(file)
    if (!Array.isArray(diagnostic.labels) || !diagnostic.labels.length) {
      throw new Error(`Quellstelle fehlt: ${file}`)
    }
    const anchors = diagnostic.labels.map(label => {
      const { offset, length } = label.span ?? {}
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 ||
          length < 0 || offset + length > source.length) throw new Error(`Ungueltiger Span: ${file}`)
      const start = offset === 0 ? 0 : source.lastIndexOf(10, offset - 1) + 1
      const newline = source.indexOf(10, offset)
      const end = newline === -1 ? source.length : newline
      const line = source.subarray(start, end).toString('utf8').trim()
      const text = source.subarray(offset, offset + length).toString('utf8').replaceAll('\r\n', '\n')
      // Gesamter vorheriger Kontext statt nur benachbarter Zeilen: gleiche
      // Anweisungen in verschiedenen Funktionen duerfen nicht kollidieren.
      const prefix = source.subarray(0, offset).toString('utf8').split('\n').map(value => value.trim())
      // Nur ein fuehrendes Kommentarvorwort ausblenden: // innerhalb eines
      // spaeteren Template-Literals ist Quelltext und darf nicht verschwinden.
      while (prefix.length && (!prefix[0] || prefix[0].startsWith('//'))) prefix.shift()
      const context = createHash('sha256').update(prefix.join('\n')).digest('hex')
      return JSON.stringify([context, line, text])
    }).sort()
    const entry = { file, rule: diagnostic.code, severity: diagnostic.severity,
      message: diagnostic.message, anchors, count: 1 }
    validateEntry(entry)
    const key = identity(entry)
    if (entries.has(key)) entries.get(key).count++
    else entries.set(key, entry)
  }
  return [...entries.values()].sort((a, b) => identity(a).localeCompare(identity(b), 'en'))
}

/** Liefert `{ entries, files }`. `files` ist die Dateizahl des Laufs, aus dem die
 *  Baseline stammt: die Untergrenze, unter die ein Lauf nicht fallen darf (siehe `run`). */
export function readBaseline(path) {
  const data = JSON.parse(readFileSync(path, 'utf8'))
  if (data.version !== 1 || !Array.isArray(data.entries) ||
      !Number.isSafeInteger(data.files) || data.files <= 0) throw new Error('Baseline-Format unbekannt')
  const seen = new Set()
  for (const entry of data.entries) {
    validateEntry(entry)
    const key = identity(entry)
    if (seen.has(key)) throw new Error('Doppelter Baseline-Eintrag')
    seen.add(key)
  }
  return { entries: data.entries, files: data.files }
}

export function compare(current, baseline) {
  const old = new Map(baseline.map(entry => [identity(entry), entry]))
  const now = new Map(current.map(entry => [identity(entry), entry]))
  const difference = (left, right) => [...left].flatMap(([key, entry]) => {
    const count = entry.count - (right.get(key)?.count ?? 0)
    return count > 0 ? [{ ...entry, count }] : []
  })
  return { added: difference(now, old), removed: difference(old, now) }
}

function lint(root, { timeout = 30_000, toolPath = join(root, 'node_modules', 'oxlint', 'bin', 'oxlint') } = {}) {
  // Direkter Node-Einstieg statt npm-Banner oder shell-abhängiger .cmd-Aufloesung.
  const result = spawnSync(process.execPath, [toolPath, '--format=json'], {
    cwd: root, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error || result.signal || ![0, 1].includes(result.status) || result.stderr.trim()) {
    throw new Error(`Linter nicht erfolgreich: ${result.error?.message ?? result.stderr.trim() ?? result.signal}`)
  }
  const report = JSON.parse(result.stdout)
  const entries = normalizeReport(report, root)
  if (result.status === 1 && !report.diagnostics.some(diagnostic => diagnostic.severity === 'error')) {
    throw new Error('Fehlerstatus ohne Fehlerdiagnose')
  }
  return { entries, files: report.number_of_files }
}

/** Manuelles Einfrieren. Der normale Riegel liest die Baseline ausschliesslich. */
export function writeBaseline(root, options) {
  const { entries, files } = lint(root, options)
  writeFileSync(join(root, baselineName), JSON.stringify({ version: 1, files, entries }, null, 2) + '\n')
  return { files, count: entries.reduce((sum, entry) => sum + entry.count, 0) }
}

export function run(root, options) {
  try {
    const { entries: baseline, files: baselineFiles } = readBaseline(join(root, baselineName))
    const { entries, files } = lint(root, options)
    // Weniger Dateien als beim Einfrieren: eine Ignore-Regel oder ein Pfadumzug hat
    // einen Teil des Baums aus dem Lauf genommen. Der Rest waere formal sauber, und der
    // Altbestand der fehlenden Dateien hiesse "behoben" (gemessen: 16 statt 185 Dateien,
    // rc 0). Wurde wirklich geloescht, ist `--schreiben` die Antwort.
    if (files < baselineFiles) {
      throw new Error(`nur ${files} Dateien geprueft, die Baseline stammt aus ${baselineFiles} — ` +
        'gewollt? Dann Baseline mit --schreiben neu einfrieren')
    }
    const { added, removed } = compare(entries, baseline)
    const count = values => values.reduce((sum, entry) => sum + entry.count, 0)
    const details = added.map(entry => `  ${entry.count}x ${entry.file}: ${entry.rule} — ${entry.message}`)
    return { code: added.length ? 1 : 0,
      message: [`oxlint-riegel: ${files} Dateien; ${count(entries)} Befunde; ${count(added)} neu; ${count(removed)} behoben`,
        ...details].join('\n') }
  } catch (error) {
    return { code: 2, message: `oxlint-riegel: Pruefung fehlgeschlagen — ${error.message}` }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--schreiben') {
    try {
      const { files, count } = writeBaseline(process.cwd())
      console.log(`oxlint-riegel: Baseline geschrieben (${files} Dateien; ${count} Befunde)`)
    } catch (error) {
      console.error(`oxlint-riegel: ${error.message}`)
      process.exitCode = 2
    }
  } else if (args.length) {
    console.error('oxlint-riegel: Verwendung: node scripts/oxlint_riegel.mjs [--schreiben]')
    process.exitCode = 2
  } else {
    const result = run(process.cwd())
    if (result.code) console.error(result.message)
    else console.log(result.message)
    process.exitCode = result.code
  }
}

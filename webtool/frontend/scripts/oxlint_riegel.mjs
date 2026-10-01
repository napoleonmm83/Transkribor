// T-006: Eingefrorener Altbestand; neue Befunde und unvollstaendige Laeufe blockieren.
// Baseline bewusst nur auf ausdruecklichen Aufruf schreiben, niemals im CI-Vergleich.
// INTENTIONAL-UNTESTED: falscher Alarm des Charakterisierungs-Gates — gepinnt durch scripts/oxlint_riegel.node-test.mjs (importiert run/compare/readBaseline/normalizeReport), das Gate kennt die Endung .node-test.mjs nicht.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
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

/** Oxlint-Spans sind UTF-8-Bytepositionen. Quelltextanker (Zeilentext + markierter
 *  Text) bleiben bei CRLF und bei Zeilenverschiebungen gleich. */
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
      // Bewusst KEIN Kontext ueber den Text davor (Entscheidung Marcus 2026-10-01):
      // ein Hash ueber den ganzen Praefix machte jede Zeile oberhalb eines
      // Altbefunds zu "1 neu, 1 behoben" und die CI rot. Gleiche Befunde derselben
      // Datei fallen zusammen und werden ueber `count` gezaehlt; ein ZUSAETZLICHES
      // Vorkommen bleibt so neu. Der Preis: wird ein Altbefund behoben und entsteht
      // zugleich ein wortgleicher in derselben Datei, faellt der Tausch nicht auf.
      return JSON.stringify([line, text])
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

const defaultTool = root => join(root, 'node_modules', 'oxlint', 'bin', 'oxlint')
function lint(root, { timeout = 30_000, toolPath = defaultTool(root) } = {}) {
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

/** Prueft oxlint diese eine Datei ueberhaupt? Eine ignorierte Datei, ausdruecklich
 *  uebergeben, ergibt `number_of_files: 0` (gemessen an oxlint 1.82: rc 1 und
 *  "No files found to lint." vor dem JSON). */
function lintetDatei(root, file, { timeout = 30_000, toolPath = defaultTool(root) } = {}) {
  const result = spawnSync(process.execPath, [toolPath, '--format=json', file], {
    cwd: root, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error || result.signal || ![0, 1].includes(result.status)) {
    throw new Error(`Linter nicht erfolgreich bei ${file}: ${result.error?.message ?? result.signal ?? result.status}`)
  }
  const start = result.stdout.indexOf('{')
  const report = start === -1 ? null : JSON.parse(result.stdout.slice(start))
  if (!report || !Number.isSafeInteger(report.number_of_files)) throw new Error(`Keine Dateizahl fuer ${file}`)
  return report.number_of_files > 0
}

/** Manuelles Einfrieren. Der normale Riegel liest die Baseline ausschliesslich.
 *  `--schreiben` ist die vorgeschriebene Antwort auf eine geloeschte Datei; es darf
 *  dabei keinen NEUEN Befund still in den Altbestand schieben. Neue Befunde brechen
 *  deshalb ab, ausser `mitNeuen` ist ausdruecklich gesetzt (`--schreiben --mit-neuen`). */
export function writeBaseline(root, options, { mitNeuen = false } = {}) {
  const { entries, files } = lint(root, options)
  const sum = values => values.reduce((total, entry) => total + entry.count, 0)
  const path = join(root, baselineName)
  // Fehlt die alte Baseline, ist das der Erstlauf. Ist sie da, aber unlesbar, wird
  // nicht still alles eingefroren — das waere derselbe Weg um die Pruefung herum.
  const added = existsSync(path) ? compare(entries, readBaseline(path).entries).added : null
  if (added?.length && !mitNeuen) {
    const details = added.map(entry => `  ${entry.count}x ${entry.file}: ${entry.rule} — ${entry.message}`)
    throw new Error([`${sum(added)} neue Befunde wuerden eingefroren — beheben, oder bewusst mit ` +
      '--schreiben --mit-neuen', ...details].join('\n'))
  }
  writeFileSync(path, JSON.stringify({ version: 1, files, entries }, null, 2) + '\n')
  return { files, count: sum(entries), frozen: added === null ? null : sum(added) }
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
    // Die Untergrenze oben vergleicht nur eine ZAHL: eine neue Datei gleicht eine
    // ignorierte aus (gemessen: HoerBalken.tsx ignoriert + src/neu.ts dazu ergab
    // "185 Dateien; 1 behoben", rc 0). "Behoben" gilt deshalb nur, wenn oxlint die
    // Datei, die noch da ist, auch wirklich prueft.
    for (const file of new Set(removed.map(entry => entry.file))) {
      if (existsSync(join(root, file)) && !lintetDatei(root, file, options)) {
        throw new Error(`${file} wird nicht mehr geprueft, ihr Altbestand hiesse sonst behoben — ` +
          'gewollt? Dann Baseline mit --schreiben neu einfrieren')
      }
    }
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
  const schreiben = args[0] === '--schreiben' &&
    (args.length === 1 || (args.length === 2 && args[1] === '--mit-neuen'))
  if (schreiben) {
    try {
      const { files, count, frozen } = writeBaseline(process.cwd(), undefined, { mitNeuen: args.length === 2 })
      const neu = frozen === null ? 'keine alte Baseline' : `davon ${frozen} neu eingefroren`
      console.log(`oxlint-riegel: Baseline geschrieben (${files} Dateien; ${count} Befunde; ${neu})`)
    } catch (error) {
      console.error(`oxlint-riegel: ${error.message}`)
      process.exitCode = 2
    }
  } else if (args.length) {
    console.error('oxlint-riegel: Verwendung: node scripts/oxlint_riegel.mjs [--schreiben [--mit-neuen]]')
    process.exitCode = 2
  } else {
    const result = run(process.cwd())
    if (result.code) console.error(result.message)
    else console.log(result.message)
    process.exitCode = result.code
  }
}

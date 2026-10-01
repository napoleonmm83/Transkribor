import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { compare, normalizeReport, readBaseline, run } from './oxlint_riegel.mjs'

const script = fileURLToPath(new URL('./oxlint_riegel.mjs', import.meta.url))
function fixture(t, source = 'const wert = 1\n') {
  const root = mkdtempSync(join(tmpdir(), 'oxlint-riegel-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'probe.ts'), source)
  return root
}
function report(overrides = {}) {
  return { number_of_files: 1, diagnostics: [{ filename: 'src/probe.ts',
    code: 'typescript(probe)', severity: 'warning', message: 'Ein Befund',
    labels: [{ span: { offset: 6, length: 4 } }],
  }], ...overrides }
}
function baseline(root, entries, files = 1) {
  writeFileSync(join(root, '.oxlint-baseline.json'), JSON.stringify({ version: 1, files, entries }))
}
function tool(root, body) {
  const path = join(root, 'node_modules', 'oxlint', 'bin', 'oxlint')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
}

test('bekannte, neue, behobene und mehrfach vorkommende Befunde', t => {
  const root = fixture(t)
  const one = normalizeReport(report(), root)
  const two = normalizeReport(report({ diagnostics: [report().diagnostics[0], report().diagnostics[0]] }), root)
  assert.deepEqual(compare(one, one), { added: [], removed: [] })
  assert.equal(compare(one, []).added.length, 1)
  assert.equal(compare([], one).removed.length, 1)
  assert.equal(compare(two, one).added[0].count, 1)
  assert.equal(compare(one, two).removed[0].count, 1)
})
test('UTF-8, Zeilenverschiebung, Windows-Pfade und CRLF behalten Identitaet', t => {
  const root = fixture(t, 'const ä = 0; const wert = 1\n')
  const data = report()
  data.diagnostics[0].labels[0].span.offset = Buffer.byteLength('const ä = 0; const ')
  const before = normalizeReport(data, root)
  writeFileSync(join(root, 'src', 'probe.ts'), '// Vorwort\r\nconst ä = 0; const wert = 1\r\n')
  data.diagnostics[0].labels[0].span.offset += Buffer.byteLength('// Vorwort\r\n')
  data.diagnostics[0].filename = 'src\\probe.ts'
  assert.deepEqual(normalizeReport(data, root), before)
})
test('neue Quellstelle derselben Regel und Datei ist neu', t => {
  const root = fixture(t)
  const before = normalizeReport(report(), root)
  writeFileSync(join(root, 'src', 'probe.ts'), 'const neu = 1\n')
  assert.equal(compare(normalizeReport(report(), root), before).added.length, 1)
})
test('Aenderung oberhalb eines Altbefunds laesst seine Identitaet stehen', t => {
  // Vorher hing die Identitaet am ganzen Text davor: ein Import oder eine Zeile in
  // einer anderen Funktion machte den unveraenderten Befund zu "1 neu, 1 behoben".
  const source = 'export function erster() {\n  return 0;\n}\nexport function zweiter() {\n  const wert = 1;\n}\n'
  const root = fixture(t, source)
  const data = report()
  data.diagnostics[0].labels[0].span.offset = Buffer.byteLength(source.slice(0, source.indexOf('wert')))
  const before = normalizeReport(data, root)
  const changed = "import { x } from './x'\n" + source.replace('return 0;', 'const neu = 2;\n  return neu;')
  writeFileSync(join(root, 'src', 'probe.ts'), changed)
  data.diagnostics[0].labels[0].span.offset = Buffer.byteLength(changed.slice(0, changed.indexOf('wert')))
  assert.deepEqual(compare(normalizeReport(data, root), before), { added: [], removed: [] })
})
test('ein zusaetzliches wortgleiches Vorkommen in derselben Datei ist neu', t => {
  const source = 'export function erster() {\n  const wert = 1;\n}\nexport function zweiter() {\n  const wert = 1;\n}\n'
  const root = fixture(t, source)
  const at = index => ({ ...report().diagnostics[0], labels: [{ span: { offset: Buffer.byteLength(source.slice(0, index)), length: 4 } }] })
  const one = normalizeReport(report({ diagnostics: [at(source.indexOf('wert'))] }), root)
  const two = normalizeReport(report({ diagnostics: [at(source.indexOf('wert')), at(source.lastIndexOf('wert'))] }), root)
  const { added } = compare(two, one)
  assert.equal(added.length, 1)
  assert.equal(added[0].count, 1)
})
test('semantischer Leerraum in Literal bleibt Teil der Identitaet', t => {
  const root = fixture(t, '"A B";\n')
  const data = report()
  data.diagnostics[0].labels[0].span = { offset: 0, length: 5 }
  const before = normalizeReport(data, root)
  writeFileSync(join(root, 'src', 'probe.ts'), '"A  B";\n')
  data.diagnostics[0].labels[0].span.length = 6
  assert.equal(compare(normalizeReport(data, root), before).added.length, 1)
})
test('identische Texte an zwei Spans einer Zeile zaehlen doppelt', t => {
  const root = fixture(t, 'wert; wert;\n')
  const at = offset => ({ ...report().diagnostics[0], labels: [{ span: { offset, length: 4 } }] })
  const one = normalizeReport(report({ diagnostics: [at(0)] }), root)
  const two = normalizeReport(report({ diagnostics: [at(0), at(6)] }), root)
  assert.equal(two[0].count, 2)
  assert.equal(compare(two, one).added[0].count, 1)
})
test('leerer sauberer Lauf braucht positive Dateizahl', t => {
  const root = fixture(t)
  assert.deepEqual(normalizeReport(report({ diagnostics: [] }), root), [])
  for (const number_of_files of [0, -1, 1.5, '1', undefined]) {
    assert.throws(() => normalizeReport(report({ number_of_files }), root))
  }
})
test('unvollstaendige Diagnose und unlesbare Quelle blockieren', t => {
  const root = fixture(t)
  for (const change of [{ code: undefined }, { severity: 'info' }, { message: '' },
    { filename: '../probe.ts' }, { filename: '/probe.ts' }, { filename: 'src/missing.ts' },
    { labels: [] }, { labels: [{ span: { offset: 999, length: 1 } }] }]) {
    const data = report()
    Object.assign(data.diagnostics[0], change)
    assert.throws(() => normalizeReport(data, root))
  }
})
test('ungueltige Baseline und doppelte Eintraege blockieren', t => {
  const root = fixture(t)
  const entries = normalizeReport(report(), root)
  baseline(root, entries)
  assert.deepEqual(readBaseline(join(root, '.oxlint-baseline.json')), { entries, files: 1 })
  for (const data of [{ version: 2, files: 1, entries }, { version: 1, files: 1 },
    { version: 1, entries }, { version: 1, files: 0, entries }, { version: 1, files: '1', entries },
    { version: 1, files: 1, entries: [...entries, ...entries] },
    { version: 1, files: 1, entries: [{ ...entries[0], count: 0 }] }]) {
    writeFileSync(join(root, '.oxlint-baseline.json'), JSON.stringify(data))
    assert.throws(() => readBaseline(join(root, '.oxlint-baseline.json')))
  }
})
test('Kindprozess: Warnung wird verglichen, Baseline bleibt unveraendert', t => {
  const root = fixture(t)
  baseline(root, normalizeReport(report(), root))
  const path = join(root, '.oxlint-baseline.json')
  tool(root, `console.log(${JSON.stringify(JSON.stringify(report()))})`)
  assert.equal(run(root).code, 0)
  baseline(root, [])
  const before = readFileSync(path, 'utf8')
  assert.equal(run(root).code, 1)
  assert.equal(readFileSync(path, 'utf8'), before)
  baseline(root, normalizeReport(report(), root))
  tool(root, `console.log(${JSON.stringify(JSON.stringify(report({ diagnostics: [] })))})`)
  const result = run(root)
  assert.equal(result.code, 0)
  assert.match(result.message, /behoben/)
})
test('weniger Dateien als beim Einfrieren blockiert, statt Altbestand als behoben zu melden', t => {
  // Eine Ignore-Regel nimmt den Baum mit Befund aus dem Lauf: formal sauber, aber
  // der Altbestand hiesse "behoben" (gemessen am echten oxlint: 16 statt 185 Dateien, rc 0).
  const root = fixture(t)
  baseline(root, normalizeReport(report(), root), 3)
  tool(root, `console.log(${JSON.stringify(JSON.stringify(report({ number_of_files: 2, diagnostics: [] })))})`)
  const result = run(root)
  assert.equal(result.code, 2)
  assert.match(result.message, /nur 2 Dateien geprueft, die Baseline stammt aus 3/)
  // Gleich viele oder mehr Dateien sind ein normaler Lauf.
  for (const number_of_files of [3, 4]) {
    tool(root, `console.log(${JSON.stringify(JSON.stringify(report({ number_of_files })))})`)
    assert.equal(run(root).code, 0)
  }
})
test('behoben zaehlt nur, wenn oxlint die noch vorhandene Datei auch prueft', t => {
  // Eine neue Datei gleicht eine ignorierte in der Dateizahl aus (gemessen am echten
  // oxlint: "185 Dateien; 1 behoben", rc 0). Ausdruecklich uebergeben meldet oxlint
  // fuer eine ignorierte Datei number_of_files 0.
  const root = fixture(t)
  baseline(root, normalizeReport(report(), root), 1)
  const voll = JSON.stringify(report({ diagnostics: [] }))
  const datei = n => JSON.stringify({ number_of_files: n, diagnostics: [] })
  const werkzeug = n => `const einzeln = process.argv.length > 3
    console.log(einzeln ? 'No files found to lint.\\n' + ${JSON.stringify(datei(n))} : ${JSON.stringify(voll)})
    process.exit(einzeln && ${n} === 0 ? 1 : 0)`
  tool(root, werkzeug(0))
  const result = run(root)
  assert.equal(result.code, 2)
  assert.match(result.message, /src\/probe\.ts wird nicht mehr geprueft/)
  tool(root, werkzeug(1))
  assert.equal(run(root).code, 0)
  // Wirklich geloescht: kein Einzellauf noetig, "behoben" bleibt.
  rmSync(join(root, 'src', 'probe.ts'))
  tool(root, werkzeug(0))
  assert.equal(run(root).code, 0)
})
test('--schreiben nennt, was gegenueber der alten Baseline neu eingefroren wird', t => {
  const root = fixture(t)
  baseline(root, [])
  tool(root, `console.log(${JSON.stringify(JSON.stringify(report()))})`)
  const result = spawnSync(process.execPath, [script, '--schreiben'], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /davon 1 neu eingefroren/)
})
test('Baseline traegt die Dateizahl des Einfrierlaufs', t => {
  const root = fixture(t)
  tool(root, `console.log(${JSON.stringify(JSON.stringify(report({ number_of_files: 7 })))})`)
  const result = spawnSync(process.execPath, [script, '--schreiben'], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.equal(readBaseline(join(root, '.oxlint-baseline.json')).files, 7)
})
test('fehlendes Tool, kaputtes JSON, leerer Lauf und abnormaler Exit blockieren', t => {
  const root = fixture(t)
  baseline(root, [])
  assert.equal(run(root).code, 2)
  for (const body of ['console.log("kein JSON")', 'process.exit(0)',
    'console.log(JSON.stringify({number_of_files:0,diagnostics:[]}))',
    'console.log(JSON.stringify({number_of_files:1,diagnostics:[]})); process.exit(2)',
    'console.log(JSON.stringify({number_of_files:1,diagnostics:[]})); process.exit(1)']) {
    tool(root, body)
    assert.equal(run(root).code, 2)
  }
})
test('Zeitlimit beendet haengenden Linter', t => {
  const root = fixture(t)
  baseline(root, [])
  tool(root, 'setInterval(() => {}, 1000)')
  assert.equal(run(root, { timeout: 100 }).code, 2)
})
test('CLI reicht Ausfallstatus durch', t => {
  const root = fixture(t)
  const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /oxlint-riegel/)
})
test('CLI friert nur explizit ein und reicht neue Befunde als rc1 durch', t => {
  const root = fixture(t)
  tool(root, `console.log(${JSON.stringify(JSON.stringify(report()))})`)
  const invoke = args => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' })
  assert.equal(invoke(['--schreiben']).status, 0)
  const path = join(root, '.oxlint-baseline.json')
  const frozen = readFileSync(path, 'utf8')
  assert.equal(invoke([]).status, 0)
  assert.equal(invoke(['--unbekannt']).status, 2)
  assert.equal(readFileSync(path, 'utf8'), frozen)
  const data = report()
  data.diagnostics[0].message = 'Ein neuer Befund'
  tool(root, `console.log(${JSON.stringify(JSON.stringify(data))})`)
  assert.equal(invoke([]).status, 1)
  assert.equal(readFileSync(path, 'utf8'), frozen)
})
test('oxlint rc1 mit Fehlerdiagnose bleibt ein Befund und wird nicht verschluckt', t => {
  const root = fixture(t)
  baseline(root, [])
  const data = report()
  data.diagnostics[0].severity = 'error'
  tool(root, `console.log(${JSON.stringify(JSON.stringify(data))}); process.exit(1)`)
  const result = run(root)
  assert.equal(result.code, 1)
  assert.match(result.message, /1 neu/)
})

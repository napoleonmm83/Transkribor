'use strict'
/**
 * Mutationsprobe zu #434. Je Mutation: anwenden, Suite fahren, NAMEN der roten Tests melden,
 * zurueckspielen. Eine Mutation, die nicht greift (Anker nicht gefunden), bricht sofort ab —
 * sonst meldet ein gruener Lauf "Waechter unbewacht", obwohl gar nichts mutiert wurde.
 */
const fs = require('node:fs')
const { execSync } = require('node:child_process')

const M = [
  ['1 Hoerer will-navigate weg', 'electron/main.js',
    "  win.webContents.on('will-navigate', navigationPruefen(true))\n", ''],
  ['2 Hoerer will-redirect weg', 'electron/main.js',
    "  win.webContents.on('will-redirect', navigationPruefen(false))\n", ''],
  ['3 eigeneHerkunft immer true', 'electron/fenster.js',
    'function eigeneHerkunft(url, eigene) {\n  let u',
    'function eigeneHerkunft(url, eigene) {\n  if (1) return true\n  let u'],
  ['4 eigeneHerkunft immer false', 'electron/fenster.js',
    'function eigeneHerkunft(url, eigene) {\n  let u',
    'function eigeneHerkunft(url, eigene) {\n  if (1) return false\n  let u'],
  ['5 file:-Zweig weg (nur origin)', 'electron/fenster.js',
    "    if (o.protocol === 'file:') {\n"
    + "      return u.protocol === 'file:' && u.host === o.host && u.pathname === o.pathname\n"
    + '    }\n', ''],
  ['11 Host-Vergleich weg (UNC auf fremden Rechner)', 'electron/fenster.js',
    'u.protocol === \'file:\' && u.host === o.host && u.pathname === o.pathname',
    "u.protocol === 'file:' && u.pathname === o.pathname"],
  ['12 Herkunftsliste beim Fensterbau eingefroren', 'electron/main.js',
    ['  const navigationPruefen = extern => (e, urlVeraltet) => {',
      '    if (eigeneHerkunft(url, [pathToFileURL(SETUP_HTML).href, backend.url()])) return'],
    ['  const eingefroren = [pathToFileURL(SETUP_HTML).href, backend.url()]\n'
      + '  const navigationPruefen = extern => (e, urlVeraltet) => {',
      '    if (eigeneHerkunft(url, eingefroren)) return']],
  ['6 Waechter gegen undurchsichtige Herkunft weg', 'electron/fenster.js',
    "    if (o.origin === 'null') return false\n", ''],
  ['7 eigener Zaehler statt geteiltem Deckel', 'electron/main.js',
    "    else abweisungProtokollieren(url, extern ? 'Navigation' : 'Weiterleitung')",
    "    else protokoll.schreiben('Navigation abgewiesen (Schema nicht erlaubt): ' + String(url).slice(0, 200))"],
  ['8 preventDefault weg', 'electron/main.js',
    '    e.preventDefault()\n', ''],
  // Die eigentlich gefaehrliche Mutation, und sie faellt bei 5 und 6 EINZELN nicht auf: erst
  // ohne BEIDE Zeilen wird aus dem Vergleich `'null' === 'null'` — und calc.exe gilt als
  // unsere setup.html. Genau das ist die naheliegende Kurzfassung dieser Funktion.
  ['10 die naive Kurzfassung (nur origin-Vergleich)', 'electron/fenster.js',
    "    if (o.protocol === 'file:') {\n"
    + "      return u.protocol === 'file:' && u.host === o.host && u.pathname === o.pathname\n"
    + '    }\n'
    + "    // Ohne echte Herkunft gibt es nichts zu vergleichen — `'null' === 'null'` waere sonst wahr.\n"
    + "    if (o.origin === 'null') return false\n", ''],
  ['13 Unterrahmen-Wache weg', 'electron/main.js',
    '    if (e.isMainFrame === false) return\n', ''],
  ['14 Unterrahmen-Wache als `!` statt `=== false` (faellt bei fehlender Angabe offen)',
    'electron/main.js',
    'if (e.isMainFrame === false) return', 'if (!e.isMainFrame) return'],
  ['15 blob: vorsorglich gesperrt (bricht die Export-Downloads)', 'electron/fenster.js',
    '  try { u = new URL(String(url)) } catch { return false }',
    '  try { u = new URL(String(url)) } catch { return false }\n'
    + "  if (u.protocol === 'blob:') return false"],
  ['16 `extern` ignoriert — auch eine Umleitung oeffnet den Browser', 'electron/main.js',
    'const ziel = extern ? externesZiel(url) : null', 'const ziel = externesZiel(url)'],
  ['17 beide Hoerer als `extern` verdrahtet', 'electron/main.js',
    "win.webContents.on('will-redirect', navigationPruefen(false))",
    "win.webContents.on('will-redirect', navigationPruefen(true))"],
  ['18 Details-url ignoriert, nur das @deprecated positionale Argument', 'electron/main.js',
    'const url = e.url ?? urlVeraltet', 'const url = urlVeraltet'],
  ['9 rohe url statt geprueftem Ziel', 'electron/main.js',
    '    if (ziel) shell.openExternal(ziel)\n    else abweisungProtokollieren(url, ',
    '    if (ziel) shell.openExternal(url)\n    else abweisungProtokollieren(url, '],
]

// Die Dateien haben CRLF; die Anker hier stehen mit LF. Ein wortwoertlicher Vergleich fand
// deshalb NICHTS — und ohne die Anker-Pruefung unten waere daraus ein gruener Lauf geworden,
// der "unbewacht" gemeldet haette, ohne je etwas mutiert zu haben.
const alsRegex = s => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\n/g, '\\r?\\n'), 'g')

for (const [name, datei, von, nach] of M) {
  const roh = fs.readFileSync(datei, 'utf8')
  // `von`/`nach` duerfen Listen sein — eine Mutation, die zwei Stellen braucht (Zeile hochziehen
  // UND Aufrufstelle umbiegen), ist sonst nicht darstellbar.
  const paare = Array.isArray(von) ? von.map((v, i) => [v, nach[i]]) : [[von, nach]]
  let mutiert = roh
  for (const [v, n] of paare) {
    const treffer = mutiert.match(alsRegex(v)) || []
    if (treffer.length === 0) { console.log(`ABBRUCH — Anker nicht gefunden: ${name}`); process.exit(1) }
    if (treffer.length > 1) { console.log(`ABBRUCH — Anker nicht EINDEUTIG (${treffer.length}x): ${name}`); process.exit(1) }
    mutiert = mutiert.replace(treffer[0], n)
  }
  fs.writeFileSync(datei, mutiert)
  let aus = ''
  try { aus = execSync('node --test electron/*.test.js', { encoding: 'utf8', shell: 'bash' }) }
  catch (e) { aus = String(e.stdout || '') }
  fs.writeFileSync(datei, roh)                       // sofort zurueck, vor jeder Auswertung
  const rot = [...aus.matchAll(/^not ok \d+ - (.+)$/gm)].map(m => m[1].replace(/\\#/g, '#'))
  console.log(`\n── ${name}`)
  console.log(rot.length ? rot.map(r => '   ROT: ' + r).join('\n') : '   ⚠ ALLES GRUEN — der Waechter ist unbewacht')
}
console.log('\nzurueckgespielt:')
console.log(execSync('git status --porcelain electron/', { encoding: 'utf8' }).trim() || '  (sauber)')

import type { FilePhase, FileState, FileWork, GlobalPhase, JobPhases } from './types'

export const PHASE_LABEL: Record<FilePhase, string> = {
  diarize: 'Diarisieren', correct: 'Korrigieren', verify: 'Verifizieren', transcribe: 'Transkribieren',
}
export const GLOBAL_LABEL: Record<GlobalPhase, string> = {
  diarize: 'Diarisieren…', prep: 'Vorbereiten…', glossary: 'Glossar wird erstellt…', download: 'Herunterladen…',
}

// Der correct-Treiber arbeitet Dateien UND Bloecke parallel (correct.py: ThreadPoolExecutor,
// gedeckelt durch _claude_slots) -> mehrere gleichzeitig aktive Dateien, und die stdout-Zeilen
// verschraenken sich. `active` ist darum nach Basisnamen indiziert; jede Zeile traegt ihren
// Basisnamen, sonst liesse sie sich keinem Lauf zuordnen. transcribe bleibt sequentiell (eine GPU).
export function parseJobPhases(kind: string, lines: string[]): JobPhases {
  const perBase: Record<string, FileState> = {}
  const active: Record<string, FileWork> = {}
  const blocks: Record<string, { done: number; total: number }> = {}
  let global: GlobalPhase | null = null
  let cursor: string | null = null            // transcribe: die eine laufende Datei

  const terminal = (base: string, state: FileState) => {
    perBase[base] = state
    delete active[base]
    delete blocks[base]
    if (cursor === base) cursor = null
  }
  // Fortschritt einer gestueckelten Datei = fertige Bloecke. Ein einzelnes 'Block 2/3' taugt
  // dafuer nicht mehr: bei parallelen Bloecken laufen 2 und 3 gleichzeitig.
  const prog = (base: string): Partial<FileWork> => {
    const b = blocks[base]
    return b ? { pct: Math.round((b.done / b.total) * 100), detail: `${b.done}/${b.total} Blöcke` } : {}
  }
  const blockDone = (base: string) => { if (blocks[base]) blocks[base].done++ }

  for (const rawLine of lines) {
    const l = rawLine.trim()
    let m: RegExpMatchArray | null

    if (kind === 'transcribe') {
      // MUSS vor den Regexen unten stehen: '[fetch] FEHLER <url>: …' wuerde sonst von
      // /^\[.+?\] FEHLER (.+?): / als Datei-Fehlschlag mit der URL als Basisnamen gelesen.
      if (l.startsWith('[fetch] ')) {
        if (/^\[fetch\] \d+ von \d+ geladen$/.test(l)) global = null
        else { cursor = null; global = 'download' }
        continue
      }
      // Whispers tqdm-Balken (stderr, in jobs.py in stdout gemergt). Jedes \r-Refresh kommt
      // dank Universal-Newlines als eigene Zeile an -> einzige Prozentquelle der Transkription.
      // Whisper haengt UserWarnings OHNE Umbruch an, darum kein $-Anker.
      if ((m = l.match(/^(\d+)%\|/))) {
        if (cursor) active[cursor] = { ...active[cursor], pct: +m[1] }
        continue
      }
      if ((m = l.match(/^\[.+?\] -> transkribiere (.+) …$/))) {
        cursor = m[1]; active[cursor] = { phase: 'transcribe' }; global = null
      }
      else if ((m = l.match(/^\[.+?\] fertig (.+?): /))) terminal(m[1], 'done')
      else if ((m = l.match(/^\[.+?\] skip \(vorhanden\): (.+)$/))) terminal(m[1], 'skipped')
      else if ((m = l.match(/^\[.+?\] FEHLER (.+?): /))) terminal(m[1], 'failed')
      continue
    }

    if (kind !== 'correct') continue

    if ((m = l.match(/^→ Diarisiere (.+) …$/))) { active[m[1]] = { phase: 'diarize' }; global = 'diarize' }
    else if ((m = l.match(/^(.+?): \d+ Segmente → (\d+) Blöcke/))) blocks[m[1]] = { done: 0, total: +m[2] }
    else if ((m = l.match(/^[✓✗↷] (.+?) · Block \d+\/\d+ (fertig|ohne|schon)/))) blockDone(m[1])
    else if ((m = l.match(/^→ Korrigiere (.+?)(?: · Block \d+\/\d+)? …$/)))
      { active[m[1]] = { phase: 'correct', ...prog(m[1]) }; global = null }
    else if ((m = l.match(/^→ Verifiziere (.+?)(?: · Block \d+\/\d+)? \(Treue gegen Roh\) …$/)))
      { active[m[1]] = { phase: 'verify', ...prog(m[1]) }; global = null }
    else if ((m = l.match(/^apply: (.+) -> edit\.json/))) terminal(m[1], 'done')
    else if ((m = l.match(/^apply: SKIP (.+) \(human_edited=/))) terminal(m[1], 'skipped')
    else if ((m = l.match(/^↷ SKIP (.+) \(human_edited=/))) terminal(m[1], 'skipped')
    else if ((m = l.match(/^apply: FEHLT (.+?)\.correction\.json/))) terminal(m[1], 'failed')
    else if ((m = l.match(/^✗ FEHLT\/ungültig: (.+?)\.correction\.json/))) terminal(m[1], 'failed')
    else if ((m = l.match(/^✗ Fehler bei (.+?): /))) terminal(m[1], 'failed')
    else if (/^diarize: \d+ Datei/.test(l)) {
      for (const [b, a] of Object.entries(active)) if (a.phase === 'diarize') delete active[b]
      if (global === 'diarize') global = null
    }
    else if (/^prep: \d+ Datei/.test(l)) { global = 'prep' }
    else if (/^(→ Glossar|✓ Glossar|↷ nutze vorhandenes _glossar)/.test(l)) { global = 'glossary' }
    // reuse / diarize-SKIP / prep-SKIP / "Diarisierung deaktiviert" -> bewusst ignoriert
  }

  return { global: Object.keys(active).length ? null : global, active, perBase }
}

/** Einzeiler fuer Toast & Co. — nie rohe Log-Zeilen anzeigen, die sind fuer den Parser, nicht fuer Menschen. */
export function describePhases(p: JobPhases): string {
  const laufende = Object.entries(p.active)
  if (!laufende.length) return p.global ? GLOBAL_LABEL[p.global] : ''
  return laufende
    .map(([base, a]) => {
      const wie = a.detail ?? (a.pct != null ? `${a.pct}%` : null)
      return `${PHASE_LABEL[a.phase]} ${base}${wie ? ` · ${wie}` : '…'}`
    })
    .join('  |  ')
}

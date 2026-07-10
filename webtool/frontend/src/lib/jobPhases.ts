import type { FilePhase, FileState, GlobalPhase, JobPhases } from './types'

// Der correct- wie der transcribe-Treiber verarbeiten Dateien STRENG SEQUENTIELL
// -> zu jedem Zeitpunkt hoechstens EIN aktiver {base, phase}-Cursor. Wir scannen die
// stdout-Zeilen der Reihe nach und pflegen cursor/global/perBase.
export function parseJobPhases(kind: string, lines: string[]): JobPhases {
  const perBase: Record<string, FileState> = {}
  let active: { base: string; phase: FilePhase } | null = null
  let global: GlobalPhase | null = null

  const terminal = (base: string, state: FileState) => {
    perBase[base] = state
    if (active?.base === base) active = null
  }

  for (const rawLine of lines) {
    const l = rawLine.trim()
    let m: RegExpMatchArray | null

    if (kind === 'transcribe') {
      if ((m = l.match(/^\[.+?\] -> transkribiere (.+) …$/))) { active = { base: m[1], phase: 'transcribe' }; global = null }
      else if ((m = l.match(/^\[.+?\] fertig (.+?): /))) terminal(m[1], 'done')
      else if ((m = l.match(/^\[.+?\] skip \(vorhanden\): (.+)$/))) terminal(m[1], 'skipped')
      else if ((m = l.match(/^\[.+?\] FEHLER (.+?): /))) terminal(m[1], 'failed')
      continue
    }

    if (kind !== 'correct') continue

    // kind === 'correct'
    if ((m = l.match(/^→ Diarisiere (.+) …$/))) { active = { base: m[1], phase: 'diarize' }; global = 'diarize' }
    else if ((m = l.match(/^→ Korrigiere (.+) …$/))) { active = { base: m[1], phase: 'correct' }; global = null }
    else if ((m = l.match(/^→ Verifiziere (.+) \(Treue gegen Roh\) …$/))) { active = { base: m[1], phase: 'verify' }; global = null }
    else if ((m = l.match(/^apply: (.+) -> edit\.json/))) terminal(m[1], 'done')
    else if ((m = l.match(/^apply: SKIP (.+) \(human_edited=/))) terminal(m[1], 'skipped')
    else if ((m = l.match(/^↷ SKIP (.+) \(human_edited=/))) terminal(m[1], 'skipped')
    else if ((m = l.match(/^apply: FEHLT (.+?)\.correction\.json/))) terminal(m[1], 'failed')
    else if ((m = l.match(/^✗ FEHLT\/ungültig: (.+?)\.correction\.json/))) terminal(m[1], 'failed')
    else if ((m = l.match(/^✗ Fehler bei (.+?): /))) terminal(m[1], 'failed')
    else if (/^diarize: \d+ Datei/.test(l)) { if (active?.phase === 'diarize') active = null; if (global === 'diarize') global = null }
    else if (/^prep: \d+ Datei/.test(l)) { active = null; global = 'prep' }
    else if (/^(→ Glossar|✓ Glossar|↷ nutze vorhandenes _glossar)/.test(l)) { active = null; global = 'glossary' }
    // reuse / diarize-SKIP / prep-SKIP / "Diarisierung deaktiviert" -> bewusst ignoriert
  }

  return { global: active ? null : global, active, perBase }
}

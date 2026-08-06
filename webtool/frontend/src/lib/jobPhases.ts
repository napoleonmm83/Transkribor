import type { FileState, GlobalPhase, JobPhases } from './types'

// Der correct- wie der transcribe-Treiber verarbeiten Dateien STRENG SEQUENTIELL
// -> zu jedem Zeitpunkt hoechstens EIN aktiver {base, phase}-Cursor. Wir scannen die
// stdout-Zeilen der Reihe nach und pflegen cursor/global/perBase.
export function parseJobPhases(kind: string, lines: string[]): JobPhases {
  const perBase: Record<string, FileState> = {}
  let active: JobPhases['active'] = null
  let global: GlobalPhase | null = null
  // Bei gechunkten Dateien (correct.py:_correct_file) kommt '→ Korrigiere' pro Block erneut;
  // der Blockzaehler steht in einer eigenen Zeile davor -> ueber die Bloecke hinweg merken.
  let chunk: { i: number; n: number } | null = null

  const terminal = (base: string, state: FileState) => {
    perBase[base] = state
    chunk = null
    if (active?.base === base) active = null
  }
  // half=0.5: der Treue-Pass ist die zweite Haelfte eines Blocks -> Balken bewegt sich zweimal je Block.
  const prog = (half: number) => chunk
    ? { pct: Math.round(((chunk.i - 1 + half) / chunk.n) * 100), detail: `Block ${chunk.i}/${chunk.n}` }
    : {}

  for (const rawLine of lines) {
    const l = rawLine.trim()
    let m: RegExpMatchArray | null

    if (kind === 'transcribe') {
      // MUSS vor den Regexen unten stehen: '[fetch] FEHLER <url>: …' wuerde sonst von
      // /^\[.+?\] FEHLER (.+?): / als Datei-Fehlschlag mit der URL als Basisnamen gelesen.
      if (l.startsWith('[fetch] ')) {
        if (/^\[fetch\] \d+ von \d+ geladen$/.test(l)) global = null
        else { active = null; global = 'download' }
        continue
      }
      // Whispers tqdm-Balken (stderr, in jobs.py in stdout gemergt). Jedes \r-Refresh kommt
      // dank Universal-Newlines als eigene Zeile an -> einzige Prozentquelle der Transkription.
      // Ohne aktive Datei (Modell laedt, Datei schon fertig) sind die Zeilen bedeutungslos.
      if ((m = l.match(/^(\d+)%\|/))) {
        if (active) active.pct = +m[1]
        continue
      }
      if ((m = l.match(/^\[.+?\] -> transkribiere (.+) …$/))) { active = { base: m[1], phase: 'transcribe' }; global = null }
      else if ((m = l.match(/^\[.+?\] fertig (.+?): /))) terminal(m[1], 'done')
      else if ((m = l.match(/^\[.+?\] skip \(vorhanden\): (.+)$/))) terminal(m[1], 'skipped')
      else if ((m = l.match(/^\[.+?\] FEHLER (.+?): /))) terminal(m[1], 'failed')
      continue
    }

    if (kind !== 'correct') continue

    // kind === 'correct'
    if ((m = l.match(/^→ Diarisiere (.+) …$/))) { active = { base: m[1], phase: 'diarize' }; global = 'diarize' }
    else if ((m = l.match(/^Block (\d+)\/(\d+) /))) chunk = { i: +m[1], n: +m[2] }
    else if ((m = l.match(/^→ Korrigiere (.+) …$/))) { active = { base: m[1], phase: 'correct', ...prog(0) }; global = null }
    else if ((m = l.match(/^→ Verifiziere (.+) \(Treue gegen Roh\) …$/))) { active = { base: m[1], phase: 'verify', ...prog(0.5) }; global = null }
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

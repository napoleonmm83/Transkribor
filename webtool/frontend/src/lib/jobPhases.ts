import type { FilePhase, FileState, FileWork, GlobalPhase, JobPhases } from './types'

export const PHASE_LABEL: Record<FilePhase, string> = {
  diarize: 'Diarisieren', correct: 'Korrigieren', verify: 'Verifizieren', transcribe: 'Transkribieren',
}
export const GLOBAL_LABEL: Record<GlobalPhase, string> = {
  diarize: 'Diarisieren…', prep: 'Vorbereiten…', glossary: 'Glossar wird erstellt…', download: 'Herunterladen…',
}
/** Fallback, solange ein Job noch keine auswertbare Zeile geschrieben hat (Prozessstart, Modell-Ladezeit). */
export const KIND_LABEL: Record<string, string> = {
  transcribe: 'Transkribieren…', correct: 'Korrigieren…', fetch: 'Herunterladen…',
}

// Der correct-Treiber arbeitet Dateien UND Bloecke parallel (correct.py: ThreadPoolExecutor,
// gedeckelt durch _claude_slots) -> mehrere gleichzeitig aktive Dateien, und die stdout-Zeilen
// verschraenken sich. `active` ist darum nach Basisnamen indiziert; jede Zeile traegt ihren
// Basisnamen, sonst liesse sie sich keinem Lauf zuordnen. transcribe bleibt sequentiell (eine GPU).
export function parseJobPhases(kind: string, lines: string[]): JobPhases {
  const perBase: Record<string, FileState> = {}
  const active: Record<string, FileWork> = {}
  // Blocknummern statt Zaehler: ein wiederverwendeter Block meldet '↷ schon vorhanden' UND
  // '✓ fertig' (correct.py faellt nach dem Reuse in dieselbe Pruefung) — ein ++ zaehlte ihn
  // doppelt und der Balken schoesse ueber 100%.
  const blocks: Record<string, { done: Set<number>; total: number }> = {}
  let global: GlobalPhase | null = null
  let cursor: string | null = null            // transcribe: die eine laufende Datei
  let bilanz: JobPhases['bilanz']

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
    if (!b) return {}
    const fertig = Math.min(b.done.size, b.total)
    return { pct: Math.round((fertig / b.total) * 100), detail: `${fertig}/${b.total} Blöcke` }
  }
  const blockDone = (base: string, nr: number) => { blocks[base]?.done.add(nr) }

  for (const rawLine of lines) {
    const l = rawLine.trim()
    let m: RegExpMatchArray | null

    // 'fetch' ist der reine Download-Job (app.py: eigene Art, damit er keinen GPU-Slot belegt).
    // Er sendet nur '[fetch] …'-Zeilen, teilt sich das Format aber mit dem CLI-Aufruf, bei dem
    // Download und Transkription noch im selben Job stecken.
    if (kind === 'transcribe' || kind === 'fetch') {
      // MUSS vor den Regexen unten stehen: '[fetch] FEHLER <url>: …' wuerde sonst von
      // /^\[.+?\] FEHLER (.+?): / als Datei-Fehlschlag mit der URL als Basisnamen gelesen.
      if (l.startsWith('[fetch] ')) {
        // Die Bilanzzeile ist die EINZIGE Auskunft dieses Laufs ueber Erfolg und Misserfolg:
        // Basisnamen gibt es hier nicht (die Datei entsteht erst beim Laden), und der Zweig
        // hier verwirft jede andere `[fetch]`-Zeile bewusst — sonst laese die FEHLER-Regex
        // die URL als Dateinamen. Ohne sie meldet ein Import, bei dem 2 von 5 Videos tot
        // sind, glatten Erfolg: `fetch.py:576` wirft nur, wenn GAR nichts geladen wurde.
        if ((m = l.match(/^\[fetch\] (\d+) von (\d+) geladen$/))) { bilanz = { ok: +m[1], gesamt: +m[2] }; global = null }
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
    else if ((m = l.match(/^(.+?): \d+ Segmente → (\d+) Blöcke/))) blocks[m[1]] = { done: new Set(), total: +m[2] }
    // ✓ / ↷ / ✗ heissen alle "laeuft nicht mehr" — ob der Block geglueckt ist, sagt am Ende
    // der Terminal-Status der Datei, nicht der Balken.
    else if ((m = l.match(/^[✓✗↷] (.+?) · Block (\d+)\/\d+ (fertig|ohne|schon)/))) blockDone(m[1], +m[2])
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

  return { global: Object.keys(active).length ? null : global, active, perBase, bilanz }
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

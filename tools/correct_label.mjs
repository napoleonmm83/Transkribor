export const meta = {
  name: 'transkribor-correct-label',
  description: 'Kontext-Korrektur und Sprecher-Labeling von Interview-Transkripten (Whisper-Rohausgabe -> lesbares, sprecher-markiertes .md)',
  phases: [
    { title: 'Glossar', detail: 'Gemeinsame Eigennamen/Kontext aus allen Transkripten extrahieren' },
    { title: 'Korrektur+Labeling', detail: 'Pro Datei: Kontextkorrektur + Sprechertrennung, schreibt .md' },
    { title: 'Verifikation', detail: 'Pro Datei: Treue-Check gegen Rohtranskript, korrigiert Übertreibungen' },
  ],
}

// args: { dir: "<...\\transkripte>", bases: ["basename", ...], context?: "Projektbeschreibung" }
const A = typeof args === 'string' ? JSON.parse(args) : args
const DIR = String(A.dir)
const BASES = A.bases
const CONTEXT = (A.context && String(A.context).trim())
  || 'Interviews (gesprochene Sprache oft Schweizerdeutsch/Dialekt), die Whisper large-v3 nach Standarddeutsch transkribiert hat. Es gibt ASR-Fehler, v.␣a. bei Eigennamen und Dialektbegriffen.'

const GLOSSARY_SCHEMA = {
  type: 'object',
  properties: {
    context_summary: { type: 'string' },
    proper_nouns: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          correct: { type: 'string' },
          variants: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
        },
        required: ['correct'],
      },
    },
    likely_corrections: {
      type: 'array',
      items: {
        type: 'object',
        properties: { wrong: { type: 'string' }, right: { type: 'string' }, why: { type: 'string' } },
        required: ['wrong', 'right'],
      },
    },
  },
  required: ['context_summary', 'proper_nouns', 'likely_corrections'],
}

const CORRECT_SCHEMA = {
  type: 'object',
  properties: {
    base: { type: 'string' },
    output_path: { type: 'string' },
    speaker_labels: { type: 'array', items: { type: 'string' } },
    corrections_count: { type: 'number' },
    uncertain_notes: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
  required: ['base', 'output_path', 'summary'],
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    base: { type: 'string' },
    verdict: { type: 'string', enum: ['clean', 'fixed'] },
    issues_found: { type: 'array', items: { type: 'string' } },
    changes_made: { type: 'array', items: { type: 'string' } },
  },
  required: ['base', 'verdict'],
}

// ---- Phase 0: gemeinsames Glossar (Barrier: braucht alle Dateien) ----
phase('Glossar')
const rawList = BASES.map((b) => `${DIR}\\${b}.raw.txt`).join('\n')
const glossary = await agent(
  `Du bereitest ein GEMEINSAMES Glossar vor, mit dem anschliessend einzelne Transkripte konsistent korrigiert werden.

Projekt-Kontext: ${CONTEXT}

Lies ALLE folgenden Roh-Transkripte vollständig:
${rawList}

Erstelle daraus ein JSON-Glossar, das die späteren Korrektur-Agenten für KONSISTENZ nutzen:
- context_summary: 3–6 Sätze, worum es geht (wiederkehrende Themen, Art der Fragen).
- proper_nouns: wiederkehrende Namen/Orte/Betriebe/Marken als {correct, variants:[so falsch gehört], note}. Nur aufnehmen, wenn mit vernünftiger Sicherheit aus Kontext oder Allgemeinwissen bestimmbar. ERFINDE KEINE Namen — im Zweifel weglassen.
- likely_corrections: wiederkehrende Nicht-Eigenname-Fehler / im Kontext sinnlose Begriffe als {wrong, right, why}. Konservativ bleiben.

Ziel ist Konsistenz über alle Dateien. Lieber wenige sichere Einträge als viele geratene.`,
  { schema: GLOSSARY_SCHEMA, effort: 'high', label: 'glossar', phase: 'Glossar' }
)

log(`Glossar: ${glossary.proper_nouns?.length || 0} Eigennamen, ${glossary.likely_corrections?.length || 0} Korrekturen`)
const gjson = JSON.stringify(glossary, null, 1)

// ---- Phase 1+2: pro Datei Korrektur → Verifikation (Pipeline, kein Barrier) ----
phase('Korrektur+Labeling')

const correctPrompt = (base) => `Du korrigierst und formatierst EIN Interview-Transkript.

Projekt-Kontext: ${CONTEXT}

Rohdaten (Whisper large-v3, mit Zeitstempeln pro Segment) liegen in:
${DIR}\\${base}.segments.txt
Lies diese Datei vollständig.

Gemeinsames Glossar (für konsistente Korrekturen über alle Interviews — nutze es):
${gjson}

AUFGABE:
1) KONTEXT ERFASSEN: Verstehe, worum es in diesem Gespräch geht.
2) KORRIGIEREN: Verbessere klare ASR-Fehler anhand des Kontexts und des Glossars — falsch gehörte Wörter, Eigennamen, im Kontext sinnlose Begriffe. Normalisiere zu lesbarem Standarddeutsch (Schweizer Schreibung, "ss" statt "ß"). WICHTIG: Bleib inhaltlich TREU — nichts erfinden, nichts hinzudichten, den Sinn NICHT verändern, nicht paraphrasieren/glätten über das Nötige hinaus. Fülltext (äh, ähm, Wiederholungen) darf dezent bereinigt werden.
3) SPRECHER MARKIEREN: Meist genau zwei Sprecher:
   - **Interviewer** = stellt die Fragen.
   - Die befragte Person = antwortet. Stellt sie sich vor (Name/Betrieb/Rolle), nutze diesen Namen als Label (z.␣B. **Hans Müller (Betrieb X)**), sonst **Befragte Person**.
   Gruppiere aufeinanderfolgende Whisper-Segmente pro Sprecherwechsel zu zusammenhängenden Redebeiträgen (Segmentgrenzen ≠ Sprecherwechsel — nutze Inhalt/Frage-Antwort-Logik und Pausen in den Zeitstempeln).
4) Bei WIRKLICH unsicheren Korrekturen: Original beibehalten und am Ende unter "## Anmerkungen" kurz notieren (nichts still erfinden).

SCHREIBE das Ergebnis als Markdown nach: ${DIR}\\${base}.md
Format:
# Interview ${base}

**Kontext:** <1–2 Sätze zu diesem konkreten Gespräch>

---

**Interviewer:** <Frage/Beitrag>

**<Name oder Befragte Person>:** <Antwort>

... (weiter im Wechsel) ...

## Anmerkungen
- <nur falls nötig: unsichere Stellen>

Gib danach das JSON-Ergebnis zurück (base, output_path, speaker_labels, corrections_count, uncertain_notes, summary).`

const verifyPrompt = (base) => `Du prüfst ein bereits korrigiertes Interview-Transkript auf TREUE und Konsistenz.

Vergleiche:
- Korrigiert:  ${DIR}\\${base}.md   (lies vollständig)
- Rohtranskript: ${DIR}\\${base}.segments.txt   (lies vollständig)

Prüfe kritisch:
1) HALLUZINATION/DRIFT: Wurde Inhalt hinzugefügt, weggelassen oder im Sinn verändert, der nicht im Roh-Transkript steht? Übermässiges Umschreiben? → zurück näher ans Original.
2) SPRECHER: Sind die Labels plausibel und konsistent (Interviewer stellt Fragen; Antworten korrekt zugeordnet)? Korrigiere Fehlzuordnungen.
3) RESTFEHLER: Offensichtliche verbleibende ASR-Fehler oder im Kontext sinnlose Begriffe (konservativ, nur wenn klar).
4) Format sauber.

Wenn Änderungen nötig: ÜBERSCHREIBE ${DIR}\\${base}.md mit der verbesserten Version (gleiches Format). Sonst nichts ändern.
Gib JSON zurück: base, verdict ('clean' oder 'fixed'), issues_found, changes_made.`

const results = await pipeline(
  BASES,
  (base) => agent(correctPrompt(base), { label: `korr:${base}`, phase: 'Korrektur+Labeling', schema: CORRECT_SCHEMA, effort: 'high' }),
  (_prev, base) => agent(verifyPrompt(base), { label: `verify:${base}`, phase: 'Verifikation', schema: VERIFY_SCHEMA, effort: 'high' })
)

return { glossary, files: results.filter(Boolean) }

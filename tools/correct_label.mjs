export const meta = {
  name: 'transkribor-correct-label',
  description: 'Segment-ausgerichtete Kontext-Korrektur + Sprecher-Labeling (liefert strukturierte Korrektur je Datei; Assembly zu edit.json/md via `python -m webtool.correct apply`)',
  phases: [
    { title: 'Glossar', detail: 'Gemeinsame Eigennamen/Kontext aus allen Roh-Transkripten' },
    { title: 'Korrektur+Labeling', detail: 'Pro Datei: segment-genaue Korrektur + Sprecher aus <base>.tagged.txt' },
    { title: 'Verifikation', detail: 'Pro Datei: Treue-Check gegen Rohtranskript' },
  ],
}

const A = typeof args === 'string' ? JSON.parse(args) : args
const DIR = String(A.dir)
const BASES = A.bases
const CONTEXT = (A.context && String(A.context).trim())
  || 'Interviews (gesprochene Sprache oft Schweizerdeutsch/Dialekt), von Whisper large-v3 nach Standarddeutsch transkribiert. Es gibt ASR-Fehler, v.a. bei Eigennamen und Dialektbegriffen.'

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

const CORRECTION_SCHEMA = {
  type: 'object',
  properties: {
    base: { type: 'string' },
    context: { type: 'string' },
    speakers: { type: 'array', items: { type: 'string' } },
    segments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          speaker: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['id', 'speaker', 'text'],
      },
    },
    annotations: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
  required: ['base', 'segments', 'summary'],
}

// ---- Phase 0: gemeinsames Glossar (Barrier: braucht alle Dateien) ----
phase('Glossar')
const rawList = BASES.map((b) => `${DIR}\\${b}.raw.txt`).join('\n')
const glossary = await agent(
  `Du bereitest ein GEMEINSAMES Glossar vor, mit dem anschliessend einzelne Transkripte konsistent korrigiert werden.

Projekt-Kontext: ${CONTEXT}

Lies ALLE folgenden Roh-Transkripte vollständig:
${rawList}

Erstelle daraus ein JSON-Glossar für KONSISTENTE Korrekturen:
- context_summary: 3–6 Sätze, worum es geht.
- proper_nouns: wiederkehrende Namen/Orte/Betriebe/Marken als {correct, variants:[so falsch gehört], note}. Nur mit vernünftiger Sicherheit. ERFINDE KEINE Namen.
- likely_corrections: wiederkehrende Nicht-Eigenname-Fehler als {wrong, right, why}. Konservativ.

Lieber wenige sichere Einträge als viele geratene.`,
  { schema: GLOSSARY_SCHEMA, effort: 'high', label: 'glossar', phase: 'Glossar' }
)
log(`Glossar: ${glossary.proper_nouns?.length || 0} Eigennamen, ${glossary.likely_corrections?.length || 0} Korrekturen`)
const gjson = JSON.stringify(glossary, null, 1)

// ---- Phase 1+2: pro Datei Korrektur → Verifikation (Pipeline) ----
phase('Korrektur+Labeling')

const correctPrompt = (base) => `Du korrigierst EIN Interview-Transkript SEGMENT FÜR SEGMENT.

Projekt-Kontext: ${CONTEXT}

Die Rohsegmente liegen (mit Segment-ID pro Zeile im Format "[<id>] <text>") in:
${DIR}\\${base}.tagged.txt
Lies diese Datei vollständig. Unsichere Wörter sind inline als [[Wort|Wahrscheinlichkeit]] markiert (niedrige Whisper-Wahrscheinlichkeit).

Gemeinsames Glossar (für konsistente Korrekturen — nutze es):
${gjson}

AUFGABE:
1) KORRIGIEREN: Verbessere klare ASR-Fehler mit Kontext + Glossar. Konzentriere dich PRIMÄR auf die [[...]]-markierten unsicheren Wörter; unmarkierte nur ändern, wenn im Kontext eindeutig falsch. Normalisiere zu lesbarem Standarddeutsch (Schweizer "ss"). Bleib TREU: nichts erfinden, Sinn NICHT verändern, nicht über das Nötige hinaus glätten. Fülltext (äh, ähm) darf dezent bereinigt werden. Gib normalen Text zurück (OHNE [[...]]-Markierungen).
2) PRO SEGMENT: Gib für JEDE Segment-ID aus der Datei GENAU EINEN Eintrag {id, speaker, text} zurück (keine ID auslassen, keine Segmente zusammenfassen — die Redebeitrags-Bündelung passiert später).
3) SPRECHER: Meist zwei — Interviewer (stellt Fragen) und die befragte Person (Name/Betrieb falls im Gespräch genannt, z.␣B. "Hans Müller", sonst "Befragte Person"). Ordne jedem Segment den passenden Sprecher zu.
4) UNSICHER: Wirklich unklare Stellen im Original belassen und in annotations (Freitext) vermerken — nichts still erfinden.

Gib das JSON-Objekt gemäss Schema zurück: base="${base}", context (1–2 Sätze zum Gespräch), speakers (Liste der vorkommenden Sprecher-Labels), segments ([{id,speaker,text}] für ALLE IDs), annotations, summary.`

const verifyPrompt = (base, corr) => `Du prüfst eine bereits erstellte SEGMENT-GENAUE Korrektur auf TREUE gegen das Rohtranskript und gibst die (ggf. korrigierte) Fassung zurück.

Rohtranskript (mit Zeitstempeln): ${DIR}\\${base}.segments.txt  — lies es vollständig.

Zu prüfende Korrektur (JSON):
${JSON.stringify(corr, null, 1)}

Prüfe kritisch:
1) HALLUZINATION/DRIFT: Wurde Inhalt hinzugefügt/weggelassen/im Sinn verändert, der nicht im Roh steht? Übermässiges Umschreiben? → näher ans Original zurück.
2) VOLLSTÄNDIGKEIT: Ist für JEDE Roh-Segment-ID genau ein Eintrag vorhanden? Fehlende ergänzen (Text nah am Roh), überzählige/zusammengefasste auftrennen.
3) SPRECHER: Plausibel und konsistent (Interviewer stellt Fragen; Antworten korrekt zugeordnet)? Korrigiere Fehlzuordnungen.
4) RESTFEHLER: Offensichtliche verbleibende ASR-Fehler (konservativ, nur wenn klar).

Gib das VOLLSTÄNDIGE, geprüfte Korrektur-Objekt gemäss Schema zurück (base, context, speakers, segments, annotations, summary). Ändere NUR, was wirklich nötig ist; unproblematische Segmente unverändert übernehmen. Ergänze in summary knapp, was du geändert hast (oder "keine Änderung").`

const corrections = await pipeline(
  BASES,
  (base) => agent(correctPrompt(base), { label: `korr:${base}`, phase: 'Korrektur+Labeling', schema: CORRECTION_SCHEMA, effort: 'high' }),
  (corr, base) => agent(verifyPrompt(base, corr), { label: `verify:${base}`, phase: 'Verifikation', schema: CORRECTION_SCHEMA, effort: 'high' })
)

return { glossary, corrections: corrections.filter(Boolean) }

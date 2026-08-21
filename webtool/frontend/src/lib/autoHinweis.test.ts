import { describe, it, expect } from 'vitest'
import { autoHinweis } from './autoHinweis'

const WAHL = [
  { id: 'ch', label: 'Schweizerdeutsch', dialekt: true },
  { id: 'de', label: 'Deutsch', dialekt: false },
  { id: 'en', label: 'Englisch', dialekt: false },
  { id: 'auto', label: 'Automatisch', dialekt: false },
]

describe('autoHinweis (#301)', () => {
  it('sagt nichts, solange nicht „automatisch" gewaehlt ist', () => {
    /* Der Satz erklaert eine Regel, die nur fuer `auto` gilt. Ein Hinweis, der immer
       dasteht, ist als Daueralarm derselbe Schaden von der anderen Seite. */
    expect(autoHinweis('ch', 'ch', WAHL)).toBeNull()
    expect(autoHinweis('en', 'ch', WAHL)).toBeNull()
  })

  it('nennt den Projekt-Standard, wenn er eine DIALEKT-Sprache ist', () => {
    /* Der einzige Fall, in dem der Vorrang das Ergebnis aendert (gemessen:
       `von_whisper_code('de', bevorzugt='ch')` -> 'ch', ohne `bevorzugt` -> 'de'). */
    const t = autoHinweis('auto', 'ch', WAHL)
    expect(t).toMatch(/Schweizerdeutsch/)
    expect(t).toMatch(/mit Dialekt-Glättung/)
  })

  it('NEGATIVKONTROLLE: ein englisches Projekt bekommt den Dialekt-Satz NICHT', () => {
    /* Die Regel, an der der bisherige Satz in Schritt 3 des Material-Dialogs falsch war:
       seine Bedingung war `projektSprache !== 'auto'`, also bekam ein en-Projekt
       „Wird Deutsch erkannt, gilt der Projekt-Standard Englisch" — gemessen gilt dort `de`.
       Der Vorrang greift NUR an der ch/de-Kollision. */
    const t = autoHinweis('auto', 'en', WAHL)
    expect(t).not.toMatch(/Englisch/)
    expect(t).toMatch(/ohne Dialekt-Glättung/)
  })

  it('kennt den Fall ohne uebergeordneten Standard (Projekt-Dialog)', () => {
    /* Dort SETZT man den Standard gerade; einen darueber gibt es nicht, `bevorzugt` waere
       `auto` und traefe nie. Deshalb dieselbe Auskunft wie bei einem Nicht-Dialekt-Standard. */
    expect(autoHinweis('auto', null, WAHL)).toMatch(/ohne Dialekt-Glättung/)
    expect(autoHinweis('auto', 'auto', WAHL)).toMatch(/ohne Dialekt-Glättung/)
  })

  it('schweigt lieber, als etwas Falsches zu sagen', () => {
    /* Kennt die Liste den Standard nicht oder fehlt das `dialekt`-Flag (aelterer Server),
       ist unbekannt, welcher der beiden Saetze stimmt. Der Satz „ohne Dialekt-Glaettung"
       waere dann eine moegliche FALSCHAUSSAGE — kein Satz ist die ehrliche Richtung. */
    expect(autoHinweis('auto', 'xx', WAHL)).toBeNull()
    // Der LEERE String ist der dritte Fall, und er unterscheidet sich von `null`: er heisst
    // „noch nicht geladen", nicht „es gibt keinen Standard" — der koennte `ch` sein, dann
    // waere OHNE eine Falschaussage. Ein frueheres `!projektStandard` warf beides in
    // denselben Zweig (Reviewbefund m3).
    expect(autoHinweis('auto', '', WAHL)).toBeNull()
    expect(autoHinweis('auto', 'ch', [{ id: 'ch', label: 'Schweizerdeutsch' }])).toBeNull()
  })
})

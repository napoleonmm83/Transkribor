import { Textarea } from '@/components/ui/textarea'

// ponytail: field-sizing-content (auto-grow) already ships in ui/textarea's base class, no inline style needed.
export function TextEditor({ initial, onCommit, onCancel }: {
  initial: string; onCommit: (text: string) => void; onCancel: () => void;
}) {
  // Ein Commit ohne echte Aenderung IST ein Abbruch. `onBlur` feuert auch beim Fehlklick, und
  // jeder Schreibvorgang setzt serverseitig human_edited=true — womit `correct.py` die Aufnahme
  // aus der AUTOMATISCHEN Korrektur nimmt (zurueck nur ueber „Neu korrigieren“ mit Rueckfrage).
  // Bei 400 Segmenten je Dokument ist der Fehlklick der Alltagsfall, nicht die Ausnahme.
  // Verglichen wird getrimmt: `render_md` strippt ohnehin, ein Leerzeichen mehr aendert am
  // Ergebnis nichts — waere aber ein Schreibvorgang mit genau dieser Nebenwirkung.
  // Der Guard sitzt HIER und nicht bei den Aufrufern: sonst hat ihn einer von beiden nicht.
  const fertig = (t: string) => t.trim() === initial.trim() ? onCancel() : onCommit(t)
  return (
    // `key={initial}`: das Feld ist unkontrolliert (`defaultValue`) und ueberlebte damit einen
    // Dokumentwechsel unter sich. Laeuft eine Korrektur fertig, waehrend hier etwas offen steht,
    // tauscht `reload()` das Dokument — die Textarea behielt den ALTEN Text und schrieb ihn beim
    // Blur ueber die frische Korrektur. Bei `dirty === false` fragt dabei nichts nach (die
    // Rueckfrage in `DateiMenue` haengt an `dirty`), und selbst wer bewusst „korrigierte Fassung
    // laden“ waehlt, verlor sie so wieder. Der Schluessel baut das Feld beim Wechsel des
    // Ausgangswerts neu auf; `autoFocus` setzt den Fokus dabei zurueck.
    <Textarea key={initial} defaultValue={initial} autoFocus
      className="min-h-0 resize-none leading-relaxed"
      onBlur={e => fertig(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); fertig(e.currentTarget.value) }
        if (e.key === 'Escape') { e.preventDefault(); onCancel() }
      }} />
  )
}

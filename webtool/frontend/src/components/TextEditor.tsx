import { useEffect, useRef } from 'react'
import { Textarea } from '@/components/ui/textarea'

// ponytail: field-sizing-content (auto-grow) already ships in ui/textarea's base class, no inline style needed.

/** Hinweis, wenn eine nicht uebernommene Eingabe durch einen neuen Ausgangswert verworfen wurde
 *  (#118). Zentral hier, damit beide Konsumenten (DokumentFeld, SegmentView) dieselbe Stimme
 *  tragen — und eine Anpassung nicht an zwei Stellen vergeigt wird.
 *
 *  Bewusst OHNE Dateinamen, anders als der Speichern-Fehler-Toast (`useDoc.ts`): dieser nennt die
 *  Datei, weil sein Fehler ASYNCHRON ist — ein Hintergrund-Lauf fuer Datei X, waehrend Y offen
 *  steht, kann lange nach dem Verlassen feuern und waere ohne Namen „ohne Bezug ueber einem
 *  fremden Dokument". Der Verwurf hier ist SYNCHRON zum Klick/Reload: er feuert im selben
 *  React-Commit wie der Wechsel, der Nutzer war gerade in dem Feld. Zusaetzlich waere der Name
 *  beim Wechsel A→B schlicht FALSCH: `doc.base` ist im Feueraugenblick schon B, die verworfene
 *  Eingabe stand aber in A. Eine generische Aussage ist fuer beide Faelle wahr. */
export const EINGABE_VERWORFEN = 'Nicht übernommene Eingabe verworfen.'

export function TextEditor({ initial, onCommit, onCancel, onVerworfen }: {
  initial: string; onCommit: (text: string) => void; onCancel: () => void; onVerworfen?: () => void;
}) {
  // Hat der Nutzer etwas getippt, ohne zu uebernehmen, und wechselt dann der Ausgangswert
  // (reload() tauscht das Dokument — #114) oder das Feld verschwindet (Dateiwechsel), waere
  // die Eingabe still verworfen. `onVerworfen` gibt dem Parent die Chance, den Nutzer zu
  // informieren (#118). Unveraenderte Felder feuern nicht — sonst Laerm bei jedem Wechsel.
  const veraendert = useRef(false)
  const erledigt = useRef(false)
  // `onVerworfen` als latest-ref: der Cleanup laeuft beim initial-Wechsel bzw. Unmount, nicht
  // bei jedem Render — ohne Ref hinge er an der Prop-Identitaet des ersten Renders.
  const cb = useRef(onVerworfen)
  cb.current = onVerworfen

  const fertig = (t: string) => {
    erledigt.current = true
    // Ein Commit ohne echte Aenderung IST ein Abbruch. `onBlur` feuert auch beim Fehlklick, und
    // jeder Schreibvorgang setzt serverseitig human_edited=true — womit `correct.py` die Aufnahme
    // aus der AUTOMATISCHEN Korrektur nimmt (zurueck nur ueber „Neu korrigieren“ mit Rueckfrage).
    // Bei 400 Segmenten je Dokument ist der Fehlklick der Alltagsfall, nicht die Ausnahme.
    // Verglichen wird getrimmt: `render_md` strippt ohnehin, ein Leerzeichen mehr aendert am
    // Ergebnis nichts — waere aber ein Schreibvorgang mit genau dieser Nebenwirkung.
    // Der Guard sitzt HIER und nicht bei den Aufrufern: sonst hat ihn einer von beiden nicht.
    if (t.trim() === initial.trim()) onCancel()
    else onCommit(t)
  }
  const abbrechen = () => { erledigt.current = true; onCancel() }

  // Cleanup bei JEDEM initial-Wechsel (die Textarea baut sich neu auf, s. `key`) UND beim
  // Unmount — beides Verwurf-Pfade. `veraendert` wird danach zurueckgesetzt, damit ein neues
  // Tippen im ersetzten Feld ein eigenes Ereignis ausloest und nicht das alte doppelt meldet.
  // `erledigt` bewusst NICHT zurueckgesetzt: kein aktueller Parent oeffnet das Feld ohne neuen
  // Mount (beide setzen `editing=false`), und der Reset waere Geruest fuer einen Fall, der nie eintritt.
  useEffect(() => {
    return () => {
      if (veraendert.current && !erledigt.current) {
        cb.current?.()
        veraendert.current = false
      }
    }
  }, [initial])

  return (
    // `key={initial}`: das Feld ist unkontrolliert (`defaultValue`) und ueberlebte damit einen
    // Dokumentwechsel unter sich. Laeuft eine Korrektur fertig, waehrend hier etwas offen steht,
    // tauscht `reload()` das Dokument — die Textarea behielt den ALTEN Text und schrieb ihn beim
    // Blur ueber die frische Korrektur. Bei `dirty === false` fragt dabei nichts nach (die
    // Rueckfrage in `DateiMenue` haengt an `dirty`), und selbst wer bewusst „korrigierte Fassung
    // laden“ waehlte, verlor sie so wieder. Der Schluessel baut das Feld beim Wechsel des
    // Ausgangswerts neu auf; `autoFocus` setzt den Fokus dabei zurueck.
    //
    // BEWUSST IN KAUF GENOMMEN: hatte der Nutzer im Feld schon getippt und noch nicht
    // uebernommen, ist das Getippte damit weg. Issue #114 hat die Frage ausdruecklich offengelassen
    // („ein stilles Verwerfen waere genauso falsch wie ein stilles Ueberschreiben“); entschieden
    // ist sie hier zugunsten des Verwerfens, weil eine fertige Korrektur schwerer wiegt als ein
    // paar nicht uebernommene Tastendruecke. Seit #118 gibt es immerhin einen Hinweis darueber
    // (`onVerworfen`), statt es still zu tun. Der Test „verwirft dabei Getipptes“ haelt die
    // Entscheidung fest, damit sie niemand fuer einen Fehler haelt.
    <Textarea key={initial} defaultValue={initial} autoFocus
      onChange={() => { veraendert.current = true }}
      className="min-h-0 resize-none leading-relaxed"
      onBlur={e => fertig(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); fertig(e.currentTarget.value) }
        if (e.key === 'Escape') { e.preventDefault(); abbrechen() }
      }} />
  )
}

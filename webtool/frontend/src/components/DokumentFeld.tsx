import { useState } from 'react'
import { toast } from 'sonner'
import { TextEditor, EINGABE_VERWORFEN } from './TextEditor'

/**
 * Ein Kopffeld des Dokuments (Kontext, Zusammenfassung) — Klick oeffnet das Textfeld.
 *
 * Der Absatz ist ein `<button>` und kein `<span onClick>` wie beim Segment: so ist er per Tab
 * erreichbar und mit Enter zu oeffnen, ohne eine Zeile extra.
 *
 * `whitespace-pre-wrap`, weil `render_md` Zeilenumbrueche durchreicht — ein Feld, das auf dem
 * Schirm anders aussieht als in der Datei, ist eines, dessen Fehler niemand sieht.
 */
export function DokumentFeld({ titel, wert, platzhalter, onCommit, aktiv = false, dimmen = false }: {
  titel: string; wert: string; platzhalter: string; onCommit: (text: string) => void;
  aktiv?: boolean; dimmen?: boolean;
}) {
  const [editing, setEditing] = useState(false)
  // Gleiche Treffer-Optik wie das Segment: gelber Ring fuer den aktiven Treffer, ausgegraut,
  // wenn die Suche läuft und dieses Feld nicht trifft (Issue #128 — Kopffelder waren davor
  // weder durchsucht noch beim Filtern ausgegraut).
  const trefferRing = aktiv ? 'ring-2 ring-inset ring-yellow-400 dark:ring-yellow-500' : ''
  return (
    <div>
      <h2 className="rubrik mb-3">{titel}</h2>
      {editing
        ? <TextEditor initial={wert}
            onCommit={t => { onCommit(t); setEditing(false) }}
            onCancel={() => setEditing(false)}
            onVerworfen={() => toast.info(EINGABE_VERWORFEN)} />
        : <button type="button" onClick={() => setEditing(true)} title={`${titel} bearbeiten`}
            className={`lesebreite w-full cursor-text whitespace-pre-wrap rounded-sm text-left text-sm leading-relaxed text-muted-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 ${trefferRing}${dimmen ? ' opacity-40' : ''}`}>
            {wert.trim() || <span className="italic opacity-60">{platzhalter}</span>}
          </button>}
    </div>
  )
}

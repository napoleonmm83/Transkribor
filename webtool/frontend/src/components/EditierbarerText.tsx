import { useState } from 'react'
import { toast } from 'sonner'
import { TextEditor, EINGABE_VERWORFEN } from './TextEditor'

/**
 * Ein Absatz, der auf Klick zum Textfeld wird — das gemeinsame Stueck von Kopffeld (#109) und
 * Anmerkung (#112). Herausgeloest, als die Anmerkungen dazukamen: die Verdrahtung „Commit
 * schliesst das Feld, ein Verwurf meldet sich“ zweimal zu fuehren hiesse, sie beim naechsten Mal
 * an einer Stelle zu vergessen — genau der Befund aus #79 (derselbe Knopf zweimal im Code).
 *
 * Der Absatz ist ein `<button>` und kein `<span onClick>` wie beim Segment: so ist er per Tab
 * erreichbar und mit Enter zu oeffnen, ohne eine Zeile extra.
 *
 * `whitespace-pre-wrap`, weil `render_md` Zeilenumbrueche durchreicht — ein Feld, das auf dem
 * Schirm anders aussieht als in der Datei, ist eines, dessen Fehler niemand sieht.
 */
export function EditierbarerText({ wert, platzhalter, onCommit, titel, className = '', aktiv = false, dimmen = false }: {
  wert: string; platzhalter: string; onCommit: (text: string) => void; titel: string;
  className?: string; aktiv?: boolean; dimmen?: boolean;
}) {
  const [editing, setEditing] = useState(false)
  // Gleiche Treffer-Optik wie das Segment: gelber Ring fuer den aktiven Treffer, ausgegraut,
  // wenn die Suche läuft und dieses Feld nicht trifft (Issue #128).
  const trefferRing = aktiv ? 'ring-2 ring-inset ring-yellow-400 dark:ring-yellow-500' : ''
  if (editing) return (
    <TextEditor initial={wert}
      onCommit={t => { onCommit(t); setEditing(false) }}
      onCancel={() => setEditing(false)}
      onVerworfen={() => toast.info(EINGABE_VERWORFEN)} />
  )
  return (
    <button type="button" onClick={() => setEditing(true)} title={titel}
      className={`cursor-text whitespace-pre-wrap rounded-sm text-left focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 ${className} ${trefferRing}${dimmen ? ' opacity-40' : ''}`}>
      {wert.trim() || <span className="italic opacity-60">{platzhalter}</span>}
    </button>
  )
}

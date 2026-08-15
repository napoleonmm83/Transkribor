import { useState } from 'react'
import { toast } from 'sonner'
import { Plus } from 'lucide-react'
import { gestrichen } from '@/lib/streichen'
import { TextEditor, EINGABE_VERWORFEN } from './TextEditor'
import { EditierbarerText } from './EditierbarerText'

const KEINE = new Set<number>()

/**
 * Der Anmerkungsblock — dieselbe Liste, die `render_md` unter „## Anmerkungen“ ausgibt.
 * Bis #112 war sie nur zu lesen: die Korrektur schreibt dort hinein, was sie NICHT raten
 * wollte, also genau die Stellen, an denen der Nutzer nacharbeiten soll — eine Liste offener
 * Punkte, die man nicht abhaken konnte.
 *
 * **Leeren streicht den Eintrag.** Das ist derselbe Grundsatz wie bei der Korrektur
 * (`apply_correction`: ein leerer `text` ist eine Entscheidung, kein fehlender Wert) und
 * spart den Loeschknopf je Zeile. Der Tooltip sagt es an, sonst faende es niemand — und seit
 * #154 bietet ein Toast den Rueckweg an (`lib/streichen`), denn eine Anmerkung hat im
 * Gegensatz zum Segmenttext keine Zweitschrift.
 *
 * **Der Block steht auch leer da** — ohne das gaebe es keinen Weg, die erste eigene Anmerkung
 * anzulegen (dieselbe Lehre wie bei den Kopffeldern in #109, wo `(context || summary) &&`
 * genau das verhinderte).
 */
export function Anmerkungen({ items, onChange, aktivIndex = null, sucheAktiv = false, treffer = KEINE }: {
  items: string[]; onChange: (next: string[]) => void;
  aktivIndex?: number | null; sucheAktiv?: boolean; treffer?: Set<number>;
}) {
  const [neu, setNeu] = useState(false)
  const setze = (i: number, text: string) => {
    if (text.trim()) { onChange(items.map((a, k) => (k === i ? text : a))); return }
    onChange(items.filter((_, k) => k !== i))
    // `items` ist die Liste VOR der Streichung — der Eintrag kommt damit an seiner Stelle
    // zurueck, nicht hinten angehaengt. Preis: wird in den vier Sekunden des Toasts eine ANDERE
    // Anmerkung geaendert, nimmt „Rueckgaengig“ die mit zurueck. Ein Updater-Rueckruf waere der
    // saubere Weg, kostet aber eine geaenderte Signatur bis in `useDoc` — fuer ein Fenster, in
    // dem man den Toast erst lesen und dann noch tippen muesste.
    gestrichen('Anmerkung', () => onChange(items))
  }

  return (
    <section className="mt-12 border-t pt-5">
      <h2 className="rubrik mb-3">Anmerkungen</h2>
      <ul className="lesebreite list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-muted-foreground">
        {/* Ring und Ausgrauen bleiben am `<li>`, nicht am Feld darin: `data-annot` ist der Anker,
            den die Suche anspringt (`Transcript.scrollOrtInView`) — Marke und Markierung
            auseinanderzuziehen hiesse, zwei Stellen im Gleichschritt halten zu muessen. */}
        {items.map((a, i) => (
          <li key={i} data-annot={i}
            className={`rounded-sm${aktivIndex === i ? ' ring-2 ring-inset ring-yellow-400 dark:ring-yellow-500' : ''}${sucheAktiv && !treffer.has(i) ? ' opacity-40' : ''}`}>
            <EditierbarerText wert={a} platzhalter="Anmerkung …" onCommit={t => setze(i, t)}
              titel="Anmerkung bearbeiten (leeren streicht sie)"
              className="w-full text-sm leading-relaxed" />
          </li>
        ))}
        {neu && (
          <li>
            {/* Ein leer uebernommener neuer Eintrag legt nichts an: `TextEditor` wertet
                „unveraendert“ als Abbruch, und der Ausgangswert ist hier der leere String. */}
            <TextEditor initial="" onCommit={t => { onChange([...items, t]); setNeu(false) }}
              onCancel={() => setNeu(false)}
              onVerworfen={() => toast.info(EINGABE_VERWORFEN)} />
          </li>
        )}
      </ul>
      {!neu && (
        <button type="button" onClick={() => setNeu(true)}
          className="mt-3 inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
          <Plus className="size-3.5" aria-hidden="true" />Anmerkung hinzufügen
        </button>
      )}
    </section>
  )
}

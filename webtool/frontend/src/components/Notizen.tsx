import type { ReactNode } from 'react'
import { bloecke } from '@/lib/notizen'

/**
 * Ein Durchgang für alle Auszeichnungen — split mit Fanggruppe behält die Treffer.
 *
 * **Die Lookarounds tragen, NICHT die Reihenfolge.** Fett steht zuerst, weil es sich so
 * liest — wirkungslos ist es trotzdem: gemessen an `**A**`, `a **b** c *d*` und beiden
 * Multiplikationsfällen liefert die getauschte Fassung dasselbe, weil `(?![\s*])` die
 * Kursiv-Alternative an einem `**` gar nicht erst greifen lässt. Die Mutation „Reihenfolge
 * tauschen" bleibt also grün; wer hier einen Wächter vermutet, sucht ihn vergebens.
 *
 * Was WIRKLICH trägt, ist der Leerraum: direkt hinter dem öffnenden und vor dem schliessenden
 * Stern darf keiner stehen. Ohne diese Regel wird aus „5 * 3 = 15 *" der Kursivbereich
 * „* 3 = 15 *" — und das ist der einzige Fall, in dem sie den Ausschlag gibt (bei „… und *so*
 * weiter" fängt ihn schon `(?![*\w])` ab, weshalb die Mutation dort grün blieb). Dieselbe
 * Regel benutzt CommonMark.
 */
const AUSZEICHNUNG =
  /(\*\*[^*]+\*\*|(?<![*\w])\*(?![\s*])[^*\n]+(?<!\s)\*(?![*\w])|`[^`]+`|\[[^\]]+\]\((?:[^()\s]|\([^()\s]*\))+\))/g

function inline(text: string): ReactNode[] {
  return text.split(AUSZEICHNUNG).map((teil, i) => {
    // Rekursiv, weil fett und `code` sich mischen: „**Kein `position: sticky`**" steht so in
    // den echten Notizen, und ohne den zweiten Durchgang blieben die Backticks im fetten Text
    // stehen (im Browser gefunden, nicht im Unit-Test — der hatte nur die reinen Faelle).
    // Terminiert, weil die Marker beim Abschneiden verschwinden und `**` innen ausgeschlossen
    // ist; im Review gegen 15 gegnerische Eingaben gemessen: Tiefe nie über 2.
    if (/^\*\*[^*]+\*\*$/.test(teil)) return <strong key={i}>{inline(teil.slice(2, -2))}</strong>
    if (/^\*[^*\n]+\*$/.test(teil)) return <em key={i}>{inline(teil.slice(1, -1))}</em>
    if (/^`[^`]+`$/.test(teil)) {
      return <code key={i} className="rounded bg-muted px-1 py-0.5 text-[0.85em]">{teil.slice(1, -1)}</code>
    }
    const link = /^\[([^\]]+)\]\((.+)\)$/.exec(teil)
    // Nur http(s). Der Text kommt über HTTP von einem fremden Server; ein `href` daraus
    // ungeprüft in ein <a> zu setzen, wäre ein Ausführungsweg (`javascript:`). Was die Probe
    // nicht besteht, bleibt sichtbarer Text — keine stille Streichung.
    if (link && /^https?:\/\//i.test(link[2])) {
      return (
        <a key={i} href={link[2]} target="_blank" rel="noreferrer"
          className="underline underline-offset-2 hover:text-foreground">{link[1]}</a>
      )
    }
    return teil
  })
}

/** Release-Notizen als lesbarer Text. Leerer Eingang heisst: nichts anzeigen, nicht "leer". */
export function Notizen({ text }: { text: string }) {
  const teile = bloecke(text)
  if (!teile.length) return null
  return (
    <div className="space-y-3 text-sm leading-relaxed text-muted-foreground">
      {teile.map((block, i) => {
        if (block.art === 'titel') {
          return <h4 key={i} className="mt-4 font-semibold text-foreground first:mt-0">{inline(block.text)}</h4>
        }
        if (block.art === 'trenner') return <hr key={i} className="border-border/60" />
        if (block.art === 'zitat') {
          return (
            <blockquote key={i} className="border-l-2 border-border pl-3">{inline(block.text)}</blockquote>
          )
        }
        if (block.art === 'liste') {
          const Liste = block.nummeriert ? 'ol' : 'ul'
          return (
            <Liste key={i} className={`space-y-1 pl-5 ${block.nummeriert ? 'list-decimal' : 'list-disc'}`}>
              {block.punkte.map((p, j) => <li key={j}>{inline(p)}</li>)}
            </Liste>
          )
        }
        return <p key={i}>{inline(block.text)}</p>
      })}
    </div>
  )
}

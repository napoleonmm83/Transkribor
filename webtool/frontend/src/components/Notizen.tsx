import type { ReactNode } from 'react'

export type Block =
  | { art: 'titel'; text: string }
  | { art: 'absatz'; text: string }
  | { art: 'liste'; punkte: string[] }

/**
 * Die Markdown-Teilmenge, die in den Release-Notizen wirklich vorkommt: `##`-Überschriften,
 * Aufzählungen, Absätze, dazu **fett**, `code` und Links. Kein Paket dafür — der Text stammt
 * aus der eigenen Feder, und react-markdown wären 100 KB für sechs Zeichenfolgen.
 *
 * Der Punkt, an dem ein zeilenweiser Renderer scheitert: die Notizen umbrechen ihre
 * Listenpunkte und Absätze mitten im Satz (~95 Zeichen). Eine Folgezeile gehört deshalb zum
 * vorhergehenden Block, bis eine LEERZEILE ihn schliesst — sonst zerfällt jeder Punkt in so
 * viele Punkte, wie er Zeilen hat.
 */
export function bloecke(text: string): Block[] {
  const raus: Block[] = []
  let offen: 'absatz' | 'liste' | null = null
  for (const roh of String(text || '').split(/\r?\n/)) {
    const zeile = roh.trim()
    if (!zeile) { offen = null; continue }

    const titel = /^#{1,6}\s+(.+)$/.exec(zeile)
    if (titel) { raus.push({ art: 'titel', text: titel[1] }); offen = null; continue }

    const letzter = raus[raus.length - 1]
    const punkt = /^[-*]\s+(.+)$/.exec(zeile)
    if (punkt) {
      if (offen === 'liste' && letzter?.art === 'liste') letzter.punkte.push(punkt[1])
      else raus.push({ art: 'liste', punkte: [punkt[1]] })
      offen = 'liste'
      continue
    }
    if (offen === 'liste' && letzter?.art === 'liste') {
      letzter.punkte[letzter.punkte.length - 1] += ' ' + zeile
      continue
    }
    if (offen === 'absatz' && letzter?.art === 'absatz') { letzter.text += ' ' + zeile; continue }
    raus.push({ art: 'absatz', text: zeile })
    offen = 'absatz'
  }
  return raus
}

/** Ein Durchgang für alle drei Auszeichnungen — split mit Fanggruppe behält die Treffer. */
const AUSZEICHNUNG = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g

function inline(text: string): ReactNode[] {
  return text.split(AUSZEICHNUNG).map((teil, i) => {
    if (/^\*\*[^*]+\*\*$/.test(teil)) return <strong key={i}>{teil.slice(2, -2)}</strong>
    if (/^`[^`]+`$/.test(teil)) {
      return <code key={i} className="rounded bg-muted px-1 py-0.5 text-[0.85em]">{teil.slice(1, -1)}</code>
    }
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(teil)
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
        if (block.art === 'liste') {
          return (
            <ul key={i} className="list-disc space-y-1 pl-5">
              {block.punkte.map((p, j) => <li key={j}>{inline(p)}</li>)}
            </ul>
          )
        }
        return <p key={i}>{inline(block.text)}</p>
      })}
    </div>
  )
}

import type { ReactNode } from 'react'

export type Block =
  | { art: 'titel'; text: string }
  | { art: 'absatz'; text: string }
  | { art: 'zitat'; text: string }
  | { art: 'trenner' }
  | { art: 'liste'; punkte: string[]; nummeriert: boolean }

/**
 * Die Markdown-Teilmenge, die in den Release-Notizen wirklich vorkommt — **gezählt, nicht
 * vermutet** (`gh api repos/…/releases?per_page=10`, die zehn Fassungen, die die Seite zeigt):
 * Überschriften 23, Aufzählungen 26, *kursiv* 25, Trennlinien 4, Nummernlisten 3, Zitat 1,
 * Links 0. Kein Paket dafür — der Text stammt aus der eigenen Feder, react-markdown wären
 * 100 KB.
 *
 * Die erste Fassung behauptete dieselbe Vollständigkeit, hatte aber nie gezählt: kursiv,
 * Nummernlisten und Trennlinien fehlten, und **6 von 10** Fassungen rendeten deshalb falsch —
 * 50 literale Sternchen, ein `---` als Absatz, und die dreischrittige Beschreibung des
 * Material-Dialogs zu EINEM Fliesstext verschmolzen. Wer hier etwas ergänzt, zählt erst.
 *
 * Der Punkt, an dem ein zeilenweiser Renderer scheitert: die Notizen umbrechen ihre
 * Listenpunkte und Absätze mitten im Satz (~95 Zeichen). Eine Folgezeile gehört deshalb zum
 * vorhergehenden Block, bis eine LEERZEILE ihn schliesst — sonst zerfällt jeder Punkt in so
 * viele Punkte, wie er Zeilen hat.
 */
export function bloecke(text: string): Block[] {
  const raus: Block[] = []
  let offen: 'absatz' | 'liste' | 'zitat' | null = null
  for (const roh of String(text || '').split(/\r?\n/)) {
    const zeile = roh.trim()
    if (!zeile) { offen = null; continue }

    // Vor dem Listen-Zweig: `---` traegt kein Leerzeichen nach dem Strich, kollidiert also
    // nicht — geprueft wird es trotzdem zuerst, damit die Reihenfolge nicht vom Zufall lebt.
    if (/^-{3,}$/.test(zeile)) { raus.push({ art: 'trenner' }); offen = null; continue }

    const titel = /^#{1,6}\s+(.+)$/.exec(zeile)
    if (titel) { raus.push({ art: 'titel', text: titel[1] }); offen = null; continue }

    const letzter = raus[raus.length - 1]

    const punkt = /^(?:([-*])|\d+[.)])\s+(.+)$/.exec(zeile)
    if (punkt) {
      const nummeriert = !punkt[1]
      // Ein Wechsel der Listenart beginnt eine neue Liste — sonst stuenden nummerierte
      // Schritte als Punkte in einer Aufzaehlung (oder umgekehrt).
      if (offen === 'liste' && letzter?.art === 'liste' && letzter.nummeriert === nummeriert) {
        letzter.punkte.push(punkt[2])
      } else {
        raus.push({ art: 'liste', punkte: [punkt[2]], nummeriert })
      }
      offen = 'liste'
      continue
    }

    const zitat = /^>\s?(.*)$/.exec(zeile)
    if (zitat) {
      if (offen === 'zitat' && letzter?.art === 'zitat') letzter.text += ' ' + zitat[1]
      else raus.push({ art: 'zitat', text: zitat[1] })
      offen = 'zitat'
      continue
    }

    // Fortsetzungszeilen: sie gehoeren dem offenen Block, egal welcher Art er ist.
    if (offen === 'liste' && letzter?.art === 'liste') {
      letzter.punkte[letzter.punkte.length - 1] += ' ' + zeile
      continue
    }
    if (offen === 'zitat' && letzter?.art === 'zitat') { letzter.text += ' ' + zeile; continue }
    if (offen === 'absatz' && letzter?.art === 'absatz') { letzter.text += ' ' + zeile; continue }
    raus.push({ art: 'absatz', text: zeile })
    offen = 'absatz'
  }
  return raus
}

/**
 * Ein Durchgang für alle Auszeichnungen — split mit Fanggruppe behält die Treffer.
 *
 * **Fett steht VOR kursiv**, sonst zerlegt die Kursiv-Alternative jedes `**fett**` (bei
 * gleicher Fundstelle gewinnt die erste Alternative). Die Kursiv-Alternative verlangt
 * ausserdem, dass direkt hinter dem öffnenden und vor dem schliessenden Stern kein Leerraum
 * steht — sonst würde aus „5 * 3 = 15 und *so*" ein Kursivbereich, der bei der Multiplikation
 * beginnt. Dieselbe Regel benutzt CommonMark.
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

import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Dialog, DialogContent, DialogTitle } from './dialog'
import { CommandDialog } from './command'

/**
 * Waechter zu #330: der ✕ eines GEROLLTEN Dialogs wanderte aus dem Bild.
 *
 * Folge von #283: seitdem ist `DialogContent` selbst der Bildlaufbehaelter
 * (`overflow-y-auto`) UND der Bezugsrahmen des `absolute` gesetzten ✕ — ein absolut
 * positioniertes Kind rollt mit dem Inhalt. Im Browser gemessen (Datei-Einstellungen,
 * 320 px Fensterhoehe, Rollweg 293 px): `top` 33 -> **-261**, komplett ausserhalb.
 * Mit der Huelle steht er an ALLEN sieben gemessenen Rollstaenden bei 17.
 *
 * Was diese Tests NICHT koennen: jsdom rechnet kein Layout — `position: sticky`, die
 * Grid-Spur und jeder Pixel sind hier unsichtbar. Geprueft wird deshalb die ZUSICHERUNG
 * (dasselbe Vorgehen wie in `dialog-hoehe.test.tsx`), die Zahlen stehen in der
 * PR-Beschreibung. Genau darum sind es MEHRERE Tests: jede der vier Zusicherungen ist
 * einzeln gestorben, als sie fehlte, und ein Sammeltest liesse den Zwilling die Luecke
 * beilaeufig zudecken (`beilaeufige-abdeckung-ist-keine`).
 */

describe('Schliesskreuz im gerollten Dialog (#330)', () => {
  it('der ✕ liegt in einer STICKY Huelle, nicht absolut im Bildlaufbehaelter', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Titel</DialogTitle>
        </DialogContent>
      </Dialog>,
    )
    const huelle = document.querySelector('[data-slot="dialog-close-huelle"]')!
    const x = document.querySelector('[data-slot="dialog-close"]')!
    expect(huelle).not.toBeNull()
    // `sticky` ist der ganze Fix: nur ein Element IM FLUSS kann kleben. `absolute` war
    // der Fehlerzustand — und `fixed` ebenfalls, das ist gemessen und nicht vermutet:
    // der ✕ rollte damit genauso weg (-261) und sprang zusaetzlich 11 px nach links.
    expect(huelle.className).toContain('sticky')
    expect(huelle.className).toContain('top-0')
    // Der ✕ muss IN der Huelle haengen — sonst klebt eine leere Huelle.
    expect(huelle.contains(x)).toBe(true)
    expect(x.className).not.toContain('top-4')
  })

  it('die Huelle steht in BEIDEN Layouts vorn — `order-first`, nicht nur die Grid-Zeile', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Titel</DialogTitle>
        </DialogContent>
      </Dialog>,
    )
    const huelle = document.querySelector('[data-slot="dialog-close-huelle"]')!
    // Der teuerste Befund dieser Arbeit, und NUR im Browser gefunden: `MaterialDialog`
    // ersetzt `grid` durch `flex flex-col`. Dort ist die Zeilenangabe wirkungslos, die
    // Huelle landete als letztes Flex-Kind UNTEN und der ✕ bei 615 von 648 px.
    // `order-first` wirkt in beiden Layouts; die Zeilenangabe gibt dem `sticky` im Grid
    // zusaetzlich den vollhohen Bezugsrahmen (`1 / -1`), ohne den es nach Zeile 1 loesst.
    expect(huelle.className).toContain('order-first')
    expect(huelle.className).toContain('row-start-1')
    expect(huelle.className).toContain('row-end-[-1]')
    // `h-0`: die Huelle darf keine Hoehe verbrauchen.
    expect(huelle.className).toContain('h-0')
  })

  it('die Huelle kostet keine Hoehe — der `gap`-Ausgleich haengt an `:has()`', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Titel</DialogTitle>
        </DialogContent>
      </Dialog>,
    )
    const inhalt = document.querySelector('[data-slot="dialog-content"]')!
    // Die Huelle belegt eine eigene Grid-Zeile und kostet damit EINE `gap-4`-Luecke:
    // ohne Ausgleich war jeder Dialog 16 px hoeher (gemessen 580 -> 596, Kopf 24,67 ->
    // 40,67). Ein negativer Rand an der Huelle SELBST hilft nicht — die Grid-Spur wird
    // bei 0 geklemmt, die Luecke bleibt (alle drei Varianten gemessen, Delta 0). Darum
    // zieht der Ausgleich am folgenden Element. Mit ihm: wieder exakt 580 / 24,67.
    expect(inhalt.className).toContain('[&:has(>[data-slot=dialog-close-huelle])>*:first-child]:-mt-4')
  })

  it('ohne ✕ gibt es keine Huelle — sonst verschoebe der Ausgleich einen fremden Dialog', () => {
    render(
      <Dialog open>
        <DialogContent showCloseButton={false}>
          <DialogTitle>Titel</DialogTitle>
        </DialogContent>
      </Dialog>,
    )
    // Negativkontrolle zum Test davor: der Ausgleich steht als feste Klasse am Inhalt,
    // greift aber nur ueber `:has(> huelle)`. Gaebe es die Huelle auch ohne ✕, zoege er
    // das erste Kind grundlos um 16 px hoch. Ein Ausgleich ohne Ursache ist derselbe
    // Fehler spiegelverkehrt.
    expect(document.querySelector('[data-slot="dialog-close-huelle"]')).toBeNull()
    expect(document.querySelector('[data-slot="dialog-close"]')).toBeNull()
  })

  it('CommandDialog reicht die fehlende Polsterung nach (`p-0`)', () => {
    render(
      <CommandDialog open title="Titel" description="Beschreibung">
        <div />
      </CommandDialog>,
    )
    const inhalt = document.querySelector('[data-slot="dialog-content"]')!
    // Die Basis gleicht mit `-top-2 -right-2` das uebliche `p-6` aus, weil die Huelle ab
    // dem INHALTSRAND rechnet. `CommandDialog` setzt `p-0` — dort zeigt der Ausgleich ins
    // Leere: gemessen hing der ✕ bei -7,3/-7,3, sichtbar AUSSERHALB des Dialogs. Mit
    // diesen zwei Klassen steht er wieder bei 16,7/16,7 wie vor dem Fix.
    // Zweiter Verbraucher mit eigener Polsterung ⇒ dieselbe Zeile, sonst haengt sein ✕ raus.
    expect(inhalt.className).toContain('[&_[data-slot=dialog-close]]:top-4')
    expect(inhalt.className).toContain('[&_[data-slot=dialog-close]]:right-4')
  })
})

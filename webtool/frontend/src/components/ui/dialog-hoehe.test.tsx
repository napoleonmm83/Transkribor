import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Dialog, DialogContent, DialogTitle } from './dialog'
import { AlertDialog, AlertDialogContent, AlertDialogTitle } from './alert-dialog'

/**
 * Waechter zu #283: ein Dialog ohne Hoehendeckel ist bei kleinem Fenster UNBEDIENBAR.
 *
 * Gemessen im Issue (Datei-Einstellungsdialog, 597 px hoch): bei 420 px Fensterhoehe steht
 * der Speichern-Knopf 64 px unterhalb des Fensters, und KEIN Weg fuehrt hin — der Dialog hat
 * keinen eigenen Bildlauf, das Dokument auch nicht, und `scrollIntoView` bewegt nichts, weil
 * er `position: fixed` ist. Weil er vertikal zentriert wird, wird gleichzeitig OBEN
 * abgeschnitten.
 *
 * ZWEI Tests, nicht einer, und das ist der Kern: `AlertDialogContent` ist ein EIGENES
 * Bauteil (`AlertDialogPrimitive.Content`) und importiert nichts aus `dialog.tsx`. Ein Fix
 * nur an der im Issue genannten Stelle liesse `DeleteProjectDialog` und die Alert-Dialoge in
 * `DateiMenue` kaputt. Ein gemeinsamer Test ueber beide waere hier wertlos: faellt der
 * Deckel an EINEM Bauteil weg, muss GENAU dessen Test rot werden — sonst deckt der Zwilling
 * die Luecke beilaeufig zu (`beilaeufige-abdeckung-ist-keine`).
 *
 * Was dieser Test NICHT kann: jsdom rechnet kein Layout. Ob der Knopf bei 420 px wirklich
 * erreichbar ist, entscheidet der Browser — Beleg gehoert in die PR-Beschreibung, nicht
 * hierher. Geprueft wird deshalb die Zusicherung selbst: das geteilte Bauteil TRAEGT einen
 * Hoehendeckel und einen eigenen Bildlauf.
 *
 * Warum der Deckel in die BASIS gehoert und nicht an die Verbraucher: `cn` ist
 * `twMerge(clsx(…))`, der Verbraucher-`className` gewinnt Konflikte. GENAU ZWEI der sechs
 * `DialogContent`-Verbraucher sagen etwas — `MaterialDialog` (`overflow-visible`, wegen des
 * animierten Rahmens) und `ui/command` (`overflow-hidden`, es rollt in `CommandList` selbst).
 * Die uebrigen vier und BEIDE `AlertDialogContent`-Verbraucher sagen nichts und bekommen den
 * Rueckfall. (Hier stand zuerst „die sechs … die nichts sagen" — falsch gezaehlt.)
 */

describe('Dialog-Hoehendeckel (#283)', () => {
  it('DialogContent deckelt die Hoehe und rollt selbst', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Titel</DialogTitle>
        </DialogContent>
      </Dialog>,
    )
    const inhalt = document.querySelector('[data-slot="dialog-content"]')!
    expect(inhalt.className).toContain('max-h-[calc(100dvh-2rem)]')
    expect(inhalt.className).toContain('overflow-y-auto')
  })

  it('AlertDialogContent ebenso — eigenes Bauteil, eigener Deckel', () => {
    render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogTitle>Titel</AlertDialogTitle>
        </AlertDialogContent>
      </AlertDialog>,
    )
    const inhalt = document.querySelector('[data-slot="alert-dialog-content"]')!
    expect(inhalt.className).toContain('max-h-[calc(100dvh-2rem)]')
    expect(inhalt.className).toContain('overflow-y-auto')
  })

  it('MaterialDialog nimmt den Basis-Bildlauf zurueck — sonst klemmt er den Rahmen', () => {
    // Kein kuenstlicher Fall, sondern der GEMESSENE: `.rahmen-animiert` setzt sein `::before`
    // auf `inset: -2px`. Ein `overflow` != visible macht daraus scrollbaren Inhalt — im
    // Browser bei 320 px erschienen beide Leisten (je 15 px) fuer 2 px Ueberlauf, und die
    // 15 px gingen von der Listenhoehe ab. `overflow-hidden` waere die falsche Ausnahme: es
    // klemmt denselben Rahmen. Die zweite Zusicherung ist die tragende — sie misst, dass
    // twMerge die Basis-Klasse WIRKLICH entfernt und nicht bloss eine zweite danebenstellt.
    render(
      <Dialog open>
        <DialogContent className="rahmen-animiert overflow-visible">
          <DialogTitle>Titel</DialogTitle>
        </DialogContent>
      </Dialog>,
    )
    const inhalt = document.querySelector('[data-slot="dialog-content"]')!
    expect(inhalt.className).toContain('overflow-visible')
    expect(inhalt.className).not.toContain('overflow-y-auto')
  })

  it('der Verbraucher schlaegt die Basis weiterhin (twMerge)', () => {
    // Negativkontrolle zur Regel oben: waere der Deckel unueberstimmbar (`!max-h-…`),
    // braechen `MaterialDialog` und `CommandDialog`, die beide bewusst eigene Werte setzen.
    // Der Test haelt fest, dass die Basis ein RUECKFALL ist, keine Vorschrift.
    // **Was er NICHT kann:** ohne den Fix ist er vollstaendig gruen — er sagt also nichts
    // darueber, dass es den Deckel gibt (das tun Test 1 und 2). Und gegen einen Deckel an
    // einem ELTERN-Element ist er blind; auch den faengt Test 1.
    render(
      <Dialog open>
        <DialogContent className="max-h-[200px] overflow-hidden">
          <DialogTitle>Titel</DialogTitle>
        </DialogContent>
      </Dialog>,
    )
    const inhalt = document.querySelector('[data-slot="dialog-content"]')!
    expect(inhalt.className).toContain('max-h-[200px]')
    expect(inhalt.className).not.toContain('max-h-[calc(100dvh-2rem)]')
    expect(inhalt.className).toContain('overflow-hidden')
    expect(inhalt.className).not.toContain('overflow-y-auto')
  })
})

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
    expect(inhalt.className).toContain('max-h-[calc(100dvh-2rem-var(--titelzeile,0px))]')
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
    expect(inhalt.className).toContain('max-h-[calc(100dvh-2rem-var(--titelzeile,0px))]')
    expect(inhalt.className).toContain('overflow-y-auto')
  })

  it('der Verbraucher schlaegt die Basis weiterhin (twMerge)', () => {
    // Negativkontrolle zur Regel oben: waere der Deckel unueberstimmbar (`!max-h-…`),
    // braechen `MaterialDialog` und `CommandDialog`, die beide bewusst eigene Werte setzen.
    // Der Test haelt fest, dass die Basis ein RUECKFALL ist, keine Vorschrift.
    // **Was er NICHT kann:** ohne den Fix ist er vollstaendig gruen — er sagt also nichts
    // darueber, dass es den Deckel gibt (das tun Test 1 und 2). Und gegen einen Deckel an
    // einem ELTERN-Element ist er blind; auch den faengt Test 1.
    // **Warum er trotzdem bleibt** (CodeRabbit-CLI schlug vor, ihn zu streichen): er ist der
    // EINZIGE Test ueber die `max-h`-Achse der Ueberstimmbarkeit, und die Mutation
    // `!max-h-…`/`!overflow-y-auto` macht ihn rot — Dekoration ist er also nicht. Hier stand
    // daneben ein zweiter, engerer Mechanismus-Test (`overflow-visible` an einem erfundenen
    // Verbraucher); der ist RAUS, weil beide an derselben Mutation starben und keiner an der
    // echten. Was der echte `MaterialDialog` tut, misst sein eigener Test in
    // `MaterialDialog.test.tsx` — der stirbt, wenn dort `overflow-visible` wegfaellt.
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

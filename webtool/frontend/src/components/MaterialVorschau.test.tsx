import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MaterialVorschau, type VorschauZeile } from './MaterialVorschau'

const zeilen: VorschauZeile[] = [
  { schluessel: 'a', anzeige: 'interview_01.mp3', sprecherText: '' },
  { schluessel: 'b', anzeige: 'team.mp3', sprecherText: '5' },
]
const basis = {
  titel: 'Dateien gewählt (2)', sprecherMax: 20, startText: 'Hinzufügen & starten',
  onAendern: () => {}, onStart: () => {}, onAbbrechen: () => {},
}

describe('MaterialVorschau', () => {
  it('zeigt je Aufnahme ein eigenes Feld — der Batch-Wert ist genau das, was nicht reicht', () => {
    /* „Meist gemischt": 2er-Interviews neben einem 5er-Team im selben Rutsch. Ein Wert fuer
       den ganzen Stapel waere fuer die Haelfte falsch, und falsch wiegt schwerer als leer —
       `num_speakers` ist exakt, keine Obergrenze (#264). */
    render(<MaterialVorschau {...basis} zeilen={zeilen} />)
    expect(screen.getByRole('textbox', { name: /interview_01\.mp3/ })).toHaveValue('')
    expect(screen.getByRole('textbox', { name: /team\.mp3/ })).toHaveValue('5')
  })

  it('meldet jede Eingabe mit ihrem Schluessel nach oben', () => {
    const onAendern = vi.fn()
    render(<MaterialVorschau {...basis} zeilen={zeilen} onAendern={onAendern} />)
    fireEvent.change(screen.getByRole('textbox', { name: /interview_01/ }), { target: { value: '2' } })
    expect(onAendern).toHaveBeenCalledWith('a', '2')
  })

  it('ist ein TEXTfeld, kein Zahlenfeld (#264: badInput loescht die Eingabe still)', () => {
    /* Bei einer ungueltigen Zwischeneingabe liefert ein `type="number"` einen LEEREN value
       (`validity.badInput`) und zeigt dem Nutzer den getippten Text trotzdem weiter an —
       gemessen: „5" dann „e" ⇒ {value: "", badInput: true}. Leer heisst hier „automatisch",
       die Zahl verschwaende also still beim blossen Vertippen. jsdom bildet `badInput` nicht
       nach; geprueft wird deshalb der FELDTYP selbst. */
    render(<MaterialVorschau {...basis} zeilen={zeilen} />)
    const feld = screen.getByRole('textbox', { name: /interview_01/ })
    expect(feld).toHaveAttribute('type', 'text')
    expect(feld).toHaveAttribute('inputmode', 'numeric')
  })

  it('leere Felder sind gueltig — leer heisst automatisch, nicht „noch nicht ausgefuellt"', () => {
    render(<MaterialVorschau {...basis} zeilen={zeilen} />)
    expect(screen.getByRole('button', { name: /Hinzufügen & starten/ })).toBeEnabled()
  })

  it('EINE ungueltige Zeile sperrt den Start, und die Zeile sagt warum', () => {
    /* Dieselbe Regel wie im Datei-Dialog: eine ungueltige Zahl sperrt den GANZEN Knopf.
       Sonst liesse sich ueber eine gueltige Nachbarzeile speichern, und die fehlerhafte
       Eingabe ginge als „automatisch" durch. */
    render(<MaterialVorschau {...basis}
      zeilen={[zeilen[0], { ...zeilen[1], sprecherText: '99' }]} />)
    expect(screen.getByRole('button', { name: /Hinzufügen & starten/ })).toBeDisabled()
    const feld = screen.getByRole('textbox', { name: /team/ })
    expect(feld).toHaveAttribute('aria-invalid', 'true')
    // Die Begruendung muss AM FELD haengen, nicht nur irgendwo stehen (#244/#266): ein
    // `aria-describedby` ins Leere ist fuer einen Screenreader stumm.
    const hilfeId = feld.getAttribute('aria-describedby')!
    expect(document.getElementById(hilfeId)?.textContent).toMatch(/1 bis 20/)
  })

  it('waehrend des Laufs ist der Start gesperrt — kein doppelter Upload per Doppelklick', () => {
    render(<MaterialVorschau {...basis} zeilen={zeilen} laeuft />)
    expect(screen.getByRole('button', { name: /Hinzufügen & starten/ })).toBeDisabled()
  })

  it('Abbrechen meldet nach oben und laedt nichts', () => {
    const onAbbrechen = vi.fn(), onStart = vi.fn()
    render(<MaterialVorschau {...basis} zeilen={zeilen}
      onAbbrechen={onAbbrechen} onStart={onStart} />)
    fireEvent.click(screen.getByRole('button', { name: /Abbrechen/ }))
    expect(onAbbrechen).toHaveBeenCalled()
    expect(onStart).not.toHaveBeenCalled()
  })
})

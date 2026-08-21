import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MaterialZeile } from './MaterialZeile'

const basis = {
  zeile: { schluessel: 'a', anzeige: 'interview.mp3', sprecherText: '', sprache: 'ch' },
  sprachChoices: [{ id: 'ch', label: 'Schweizerdeutsch' }, { id: 'en', label: 'Englisch' }],
  sprecherMax: 20, hoerbar: true, klingt: false,
  onSprecher: () => {}, onSprache: () => {}, onHoeren: () => {},
}

describe('MaterialZeile', () => {
  it('zeigt statt eines leeren Waehlers den Projekt-Standard (#305)', () => {
    /* Ohne Optionen ist ein `<select>` ein Bedienelement, das nichts anbietet — der Nutzer
       sieht ein Feld, kann es aufklappen und findet NICHTS, ohne zu erfahren warum.
       Erreichbar beim Laden (kurz) und nach einem gescheiterten Einstellungs-GET (dauerhaft).
       Statt eines `disabled`-Waehlers ein Text: ein deaktiviertes Feld ist nicht
       fokussierbar, seine Begruendung kaeme per `aria-describedby` also nie an (#245). */
    render(<MaterialZeile {...basis} sprachChoices={[]}
      zeile={{ ...basis.zeile, sprache: '' }} />)
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.getByText(/Projekt-Standard/)).toBeInTheDocument()
  })

  it('beschriftet das Sprecherfeld AM Feld, nicht darunter (S1)', () => {
    /* Vorher stand „automatisch" als Platzhalter im Feld und „Anzahl Sprecher" als Zeile
       DARUNTER — der Hinweis kam nach dem Element, das er erklaert. */
    render(<MaterialZeile {...basis} />)
    expect(screen.getByRole('textbox', { name: /Anzahl Sprecher für interview\.mp3/ }))
      .toBeInTheDocument()
  })

  it('ist ein Textfeld, KEIN Zahlenfeld (#264)', () => {
    /* jsdom bildet `badInput` nicht nach — im Browser gemessen: ein Zahlenfeld liefert bei
       „5e" value:"" und zeigt den Text trotzdem. Leer heisst hier „automatisch", die Zahl
       verschwaende also still. Der Unit-Test prueft deshalb den TYP. */
    render(<MaterialZeile {...basis} />)
    const feld = screen.getByRole('textbox', { name: /Anzahl Sprecher/ })
    expect(feld).toHaveAttribute('type', 'text')
    expect(feld).toHaveAttribute('inputmode', 'numeric')
  })

  it('markiert eine ungueltige Eingabe und nennt die Grenze', () => {
    render(<MaterialZeile {...basis}
      zeile={{ ...basis.zeile, sprecherText: '99' }} />)
    const feld = screen.getByRole('textbox', { name: /Anzahl Sprecher/ })
    expect(feld).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText(/1 bis 20/)).toBeInTheDocument()
  })

  it('haelt die Hilfe-Id auch bei einem Dateinamen mit LEERZEICHEN zusammen (#244)', () => {
    /* Der Plan liess diese Mutation („hilfeId aus dem Schluessel") ohne Test, weil jsdom
       `aria-describedby` nicht aufloest. Die URSACHE des Zerfalls ist aber sehr wohl
       pruefbar: das Attribut ist eine durch LEERZEICHEN getrennte Liste — eine Id aus
       „Interview Mueller.mp3" zerfiele darin in zwei tote Referenzen. Geprueft wird
       deshalb, dass die Id kein Leerzeichen enthaelt UND dass sie im Dokument existiert. */
    render(<MaterialZeile {...basis}
      zeile={{ schluessel: 'Interview Mueller.mp3', anzeige: 'Interview Mueller.mp3',
               sprecherText: '99', sprache: 'ch' }} />)
    const id = screen.getByRole('textbox', { name: /Anzahl Sprecher/ })
      .getAttribute('aria-describedby')
    expect(id).toBeTruthy()
    expect(id).not.toMatch(/\s/)
    expect(document.getElementById(id!)).toHaveTextContent(/1 bis 20/)
  })

  it('sperrt den Hoerknopf beim URL-Import und sagt WARUM', () => {
    /* Das Video ist an dieser Stelle nur ein Link — es gibt nichts abzuspielen. Ein still
       toter Knopf waere schlimmer als ein gesperrter mit Begruendung. */
    render(<MaterialZeile {...basis} hoerbar={false} />)
    const knopf = screen.getByRole('button', { name: /interview\.mp3/ })
    expect(knopf).toBeDisabled()
    // Der Plan schrieb hier /heruntergeladen/i, sein eigenes Markup sagt aber „nach dem
    // Herunterladen" — die Zusicherung ist dieselbe (der Knopf nennt den Grund), nur das Wort
    // stimmt jetzt mit dem ueberein, was dasteht.
    expect(knopf).toHaveAccessibleName(/nach dem Herunterladen/i)
  })

  it('meldet Sprach- und Sprecheraenderung mit ihrem Schluessel nach oben', () => {
    const onSprecher = vi.fn(); const onSprache = vi.fn()
    render(<MaterialZeile {...basis} onSprecher={onSprecher} onSprache={onSprache} />)
    fireEvent.change(screen.getByRole('textbox', { name: /Anzahl Sprecher/ }),
                     { target: { value: '3' } })
    expect(onSprecher).toHaveBeenCalledWith('a', '3')
    fireEvent.change(screen.getByRole('combobox', { name: /Sprache für interview\.mp3/ }),
                     { target: { value: 'en' } })
    expect(onSprache).toHaveBeenCalledWith('a', 'en')
  })
})

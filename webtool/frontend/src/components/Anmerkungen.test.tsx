import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Anmerkungen } from './Anmerkungen'

// `toast` ist hier zugleich Funktion (der Streich-Hinweis aus `lib/streichen`) und Namensraum
// (`toast.info` fuer den verworfenen Eingabetext) — beides muss die Attrappe koennen.
const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { info: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMock }))

/** Die Aktion aus dem zuletzt gezeigten Toast — `undefined`, wenn gar keiner kam. */
const rueckgaengig = () =>
  toastMock.mock.calls.at(-1)?.[1]?.action as { label: string; onClick: () => void } | undefined

/** Issue #112: die Liste war nur zu lesen — weder geradeziehen noch streichen noch ergaenzen. */
describe('Anmerkungen', () => {
  it('zeigt die Rubrik auch leer — sonst gibt es keinen Weg zur ersten Anmerkung', () => {
    render(<Anmerkungen items={[]} onChange={vi.fn()} />)
    expect(screen.getByText('Anmerkungen')).toBeInTheDocument()
    expect(screen.getByText('Anmerkung hinzufügen')).toBeInTheDocument()
  })

  it('haengt eine neue Anmerkung an', () => {
    const onChange = vi.fn()
    render(<Anmerkungen items={['alt']} onChange={onChange} />)
    fireEvent.click(screen.getByText('Anmerkung hinzufügen'))
    const feld = screen.getByRole('textbox')
    fireEvent.change(feld, { target: { value: 'neu' } })
    fireEvent.blur(feld)
    expect(onChange).toHaveBeenCalledWith(['alt', 'neu'])
  })

  it('leer wieder zugeklickt legt nichts an', () => {
    // `TextEditor` wertet „unveraendert“ als Abbruch, und der Ausgangswert ist hier "". Ohne das
    // erzeugte jeder Fehlklick auf „hinzufuegen“ einen leeren Eintrag — und ein Schreibvorgang
    // setzt serverseitig human_edited=true, was die Datei aus der automatischen Korrektur nimmt.
    const onChange = vi.fn()
    render(<Anmerkungen items={[]} onChange={onChange} />)
    fireEvent.click(screen.getByText('Anmerkung hinzufügen'))
    fireEvent.blur(screen.getByRole('textbox'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('ersetzt eine bestehende Anmerkung an ihrer Stelle', () => {
    const onChange = vi.fn()
    render(<Anmerkungen items={['erste', 'zweite']} onChange={onChange} />)
    fireEvent.click(screen.getByText('zweite'))
    const feld = screen.getByRole('textbox')
    fireEvent.change(feld, { target: { value: 'zweite, berichtigt' } })
    fireEvent.blur(feld)
    expect(onChange).toHaveBeenCalledWith(['erste', 'zweite, berichtigt'])
  })

  it('leeren streicht den Eintrag (statt einer leeren Zeile)', () => {
    const onChange = vi.fn()
    render(<Anmerkungen items={['erledigt', 'offen']} onChange={onChange} />)
    fireEvent.click(screen.getByText('erledigt'))
    const feld = screen.getByRole('textbox')
    fireEvent.change(feld, { target: { value: '  ' } })
    fireEvent.blur(feld)
    expect(onChange).toHaveBeenCalledWith(['offen'])
  })

  // Issue #154: die Streichung hat keine Zweitschrift (anders als der Segmenttext mit `raw_text`),
  // und der Autosave schreibt sie 800 ms spaeter weg. Ohne Rueckweg kostet ein Fehlklick genau die
  // Notiz darueber, dass an einer Stelle nachzuarbeiten waere.
  it('bietet nach dem Streichen einen Rueckweg an, der den Eintrag an seiner Stelle zurueckholt', () => {
    toastMock.mockClear()
    const onChange = vi.fn()
    const { rerender } = render(<Anmerkungen items={['erste', 'zweite', 'dritte']} onChange={onChange} />)
    fireEvent.click(screen.getByText('zweite'))
    const feld = screen.getByRole('textbox')
    fireEvent.change(feld, { target: { value: '' } })
    fireEvent.blur(feld)
    expect(onChange).toHaveBeenCalledWith(['erste', 'dritte'])

    // Den Re-Render liefert in der App `updateDoc` -> `setDoc`; hier von Hand, sonst saehe der
    // Rueckweg die Liste von VOR der Streichung und legte den Eintrag ein zweites Mal an.
    rerender(<Anmerkungen items={['erste', 'dritte']} onChange={onChange} />)
    const aktion = rueckgaengig()
    expect(aktion?.label).toBe('Rückgängig')
    aktion!.onClick()
    // An seiner STELLE, nicht hinten angehaengt — die Liste ist die Reihenfolge des Transkripts.
    expect(onChange).toHaveBeenLastCalledWith(['erste', 'zweite', 'dritte'])
  })

  it('der Rueckweg nimmt zwischenzeitliche Aenderungen NICHT mit zurueck', () => {
    // CodeRabbit: der Rueckruf lebt zehn Sekunden. Stellte er die Liste von damals wieder her,
    // waere jede Anmerkung, die inzwischen geaendert oder angelegt wurde, weg — stiller Verlust
    // in genau dem Feld, gegen dessen Verlust #154 geschrieben ist, ausgeloest ausgerechnet vom
    // Rettungsknopf. Deshalb wird der Eintrag in die AKTUELLE Liste zurueckgeschoben.
    toastMock.mockClear()
    const onChange = vi.fn()
    const { rerender } = render(<Anmerkungen items={['erste', 'zweite', 'dritte']} onChange={onChange} />)
    fireEvent.click(screen.getByText('zweite'))
    const feld = screen.getByRole('textbox')
    fireEvent.change(feld, { target: { value: '' } })
    fireEvent.blur(feld)

    // Der Nutzer arbeitet weiter: „dritte" wird berichtigt, eine vierte kommt dazu.
    rerender(<Anmerkungen items={['erste', 'dritte, berichtigt', 'vierte']} onChange={onChange} />)
    rueckgaengig()!.onClick()

    expect(onChange).toHaveBeenLastCalledWith(['erste', 'zweite', 'dritte, berichtigt', 'vierte'])
  })

  it('haengt den Eintrag an, wenn die Liste inzwischen kuerzer ist als sein Index', () => {
    // Kein Waechtertest — `slice` klemmt selbst, eine zusaetzliche Klammerung liess sich nicht
    // rot bekommen und ist deshalb draussen. Der Test haelt trotzdem, was zaehlt: der Eintrag
    // geht in diesem Fall nicht verloren, sondern landet hinten.
    toastMock.mockClear()
    const onChange = vi.fn()
    const { rerender } = render(<Anmerkungen items={['a', 'b', 'c', 'd']} onChange={onChange} />)
    fireEvent.click(screen.getByText('d'))
    const feld = screen.getByRole('textbox')
    fireEvent.change(feld, { target: { value: '' } })
    fireEvent.blur(feld)

    rerender(<Anmerkungen items={['a']} onChange={onChange} />)
    rueckgaengig()!.onClick()

    expect(onChange).toHaveBeenLastCalledWith(['a', 'd'])
  })

  it('meldet beim blossen Aendern keinen Streich-Toast', () => {
    // Gegenprobe: ein Rueckweg, der IMMER angeboten wird, ist derselbe Schaden von der anderen
    // Seite — Dauerlaerm, bis niemand mehr hinsieht.
    toastMock.mockClear()
    render(<Anmerkungen items={['erste']} onChange={vi.fn()} />)
    fireEvent.click(screen.getByText('erste'))
    const feld = screen.getByRole('textbox')
    fireEvent.change(feld, { target: { value: 'erste, berichtigt' } })
    fireEvent.blur(feld)
    expect(toastMock).not.toHaveBeenCalled()
  })

  it('unveraendert wieder zugeklickt schreibt gar nichts', () => {
    const onChange = vi.fn()
    render(<Anmerkungen items={['unberuehrt']} onChange={onChange} />)
    fireEvent.click(screen.getByText('unberuehrt'))
    fireEvent.blur(screen.getByRole('textbox'))
    expect(onChange).not.toHaveBeenCalled()
  })
})

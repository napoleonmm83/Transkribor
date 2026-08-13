import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Anmerkungen } from './Anmerkungen'

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

  it('unveraendert wieder zugeklickt schreibt gar nichts', () => {
    const onChange = vi.fn()
    render(<Anmerkungen items={['unberuehrt']} onChange={onChange} />)
    fireEvent.click(screen.getByText('unberuehrt'))
    fireEvent.blur(screen.getByRole('textbox'))
    expect(onChange).not.toHaveBeenCalled()
  })
})

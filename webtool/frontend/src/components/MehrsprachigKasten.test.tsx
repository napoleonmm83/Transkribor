import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MehrsprachigKasten } from './MehrsprachigKasten'

describe('MehrsprachigKasten', () => {
  it('nennt die Checkbox kurz und haengt die Erklaerung als Beschreibung an', () => {
    /* Lag der Erklaertext IM <label>, wurde er Teil des Accessible Name: der Screenreader
       las drei Zeilen als Beschriftung vor. Geprueft wird deshalb der NAME (kurz) getrennt
       von der BESCHREIBUNG (aria-describedby) — nicht bloss, dass der Text irgendwo steht. */
    render(<MehrsprachigKasten wert={false} setzen={() => {}} id="x" />)
    const kasten = screen.getByRole('checkbox', { name: 'Enthält weitere Sprachen' })
    expect(kasten).toHaveAttribute('aria-describedby', 'x-hinweis')
    expect(document.getElementById('x-hinweis')).toHaveTextContent(/Hauptsprache/)
  })

  it('vergibt je Einbauort eine eigene id', () => {
    /* Vier Einbauorte, zwei davon gleichzeitig auf einer Seite (Upload + URL-Import).
       Eine feste id waere doppeltes HTML und die Beschreibung landete am falschen Element. */
    const { rerender } = render(<MehrsprachigKasten wert={false} setzen={() => {}} id="a" />)
    expect(screen.getByRole('checkbox')).toHaveAttribute('aria-describedby', 'a-hinweis')
    rerender(<MehrsprachigKasten wert={false} setzen={() => {}} id="b" />)
    expect(screen.getByRole('checkbox')).toHaveAttribute('aria-describedby', 'b-hinweis')
  })

  it('meldet den Wechsel', async () => {
    const setzen = vi.fn()
    render(<MehrsprachigKasten wert={false} setzen={setzen} />)
    screen.getByRole('checkbox').click()
    expect(setzen).toHaveBeenCalledWith(true)
  })
})

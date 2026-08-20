import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Ablageflaeche } from './Ablageflaeche'

const toastMock = vi.hoisted(() => Object.assign(vi.fn(),
  { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), dismiss: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMock }))

beforeEach(() => vi.clearAllMocks())

/* Diese Zusicherungen kommen aus `UploadDropzone.test.tsx` mit — sie haetten sonst mit der
   Datei ihren Gegenstand verloren, ohne dass ein Lauf rot wird. */
describe('Ablageflaeche', () => {
  it('waehrend eines Laufs oeffnet auch die TASTATUR keinen Dateidialog', () => {
    /* Sonst oeffnet Enter den Dateidialog, der Nutzer waehlt aus, und die Auswahl wird still
       verworfen: ein toter Weg, der ausgerechnet die Tastaturbedienung trifft — mit der Maus
       passiert sichtbar nichts, per Tastatur passiert scheinbar etwas und dann doch nicht. */
    render(<Ablageflaeche gesperrt onDateien={() => {}} />)
    const feld = screen.getByTestId('ablage-input')
    const klick = vi.spyOn(feld, 'click')
    fireEvent.keyDown(screen.getByRole('button', { name: /Audio hochladen/ }), { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: /Audio hochladen/ }))
    expect(klick).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /Audio hochladen/ }))
      .toHaveAttribute('aria-disabled', 'true')
  })

  it('oeffnet den Dateidialog per Tastatur, wenn NICHTS laeuft', () => {
    /* Positivkontrolle: eine Sperre, die immer sperrt, ist derselbe tote Weg von der
       anderen Seite. */
    render(<Ablageflaeche onDateien={() => {}} />)
    const klick = vi.spyOn(screen.getByTestId('ablage-input'), 'click')
    fireEvent.keyDown(screen.getByRole('button', { name: /Audio hochladen/ }), { key: 'Enter' })
    expect(klick).toHaveBeenCalled()
  })

  it('waehrend eines Laufs nimmt die Flaeche auch keinen DROP an', () => {
    const onDateien = vi.fn()
    render(<Ablageflaeche gesperrt onDateien={onDateien} />)
    fireEvent.drop(screen.getByRole('button', { name: /Audio hochladen/ }),
                   { dataTransfer: { files: [new File(['x'], 'a.mp3')] } })
    expect(onDateien).not.toHaveBeenCalled()
  })

  it('filtert Nicht-Audio weg und sagt es, statt still nichts zu tun', () => {
    /* Das `accept` des Dateifelds gilt nur fuer den Dateidialog — ein Drop kommt daran
       vorbei. Ohne den Filter entstuende eine Zeile fuer `brief.pdf`, und der Server
       antwortete mit einem Fehler auf etwas, das die Oberflaeche haette wissen koennen. */
    const onDateien = vi.fn()
    render(<Ablageflaeche onDateien={onDateien} />)
    fireEvent.drop(screen.getByRole('button', { name: /Audio hochladen/ }),
                   { dataTransfer: { files: [new File(['x'], 'brief.pdf')] } })
    expect(onDateien).not.toHaveBeenCalled()
    expect(toastMock.info).toHaveBeenCalledWith(expect.stringMatching(/[Kk]eine Audiodatei/))
  })

  it('laesst Audio durch, auch neben einer fremden Datei', () => {
    const onDateien = vi.fn()
    render(<Ablageflaeche onDateien={onDateien} />)
    fireEvent.drop(screen.getByRole('button', { name: /Audio hochladen/ }), {
      dataTransfer: { files: [new File(['x'], 'brief.pdf'), new File(['x'], 'a.mp3')] },
    })
    expect(onDateien).toHaveBeenCalledWith([expect.objectContaining({ name: 'a.mp3' })])
    expect(toastMock.info).not.toHaveBeenCalled()
  })
})

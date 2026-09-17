import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as api from '@/lib/api'
import { ProjektKontextDialog } from './ProjektKontextDialog'

const data = { text: 'Bergtal\nKäser AG', dateistand: 'revision-1', projektinstanz: 'instance-1' }
afterEach(() => vi.restoreAllMocks())

describe('Projektwissen', () => {
  it('lädt und speichert mehrzeiligen Text mit den geladenen Kennungen', async () => {
    vi.spyOn(api, 'getProjektKontext').mockResolvedValue(data)
    const save = vi.spyOn(api, 'saveProjektKontext').mockResolvedValue(data)
    const close = vi.fn()
    render(<ProjektKontextDialog project="Demo" offen onOpenChange={close} />)
    fireEvent.change(await screen.findByLabelText('Projektwissen'), { target: { value: 'Bergtal\nNeuer Begriff' } })
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith('Demo', { ...data, text: 'Bergtal\nNeuer Begriff' }))
    expect(close).toHaveBeenCalledWith(false)
  })

  it('behält die Eingabe bei einem Speicherkonflikt', async () => {
    vi.spyOn(api, 'getProjektKontext').mockResolvedValue(data)
    vi.spyOn(api, 'saveProjektKontext').mockRejectedValue(new Error('Inzwischen geändert'))
    const close = vi.fn()
    render(<ProjektKontextDialog project="Demo" offen onOpenChange={close} />)
    const field = await screen.findByLabelText('Projektwissen')
    fireEvent.change(field, { target: { value: 'Meine Begriffe' } })
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Inzwischen geändert')
    expect(field).toHaveValue('Meine Begriffe')
    expect(close).not.toHaveBeenCalled()
  })

  it('sperrt Speichern nach fehlgeschlagenem Laden und bietet erneutes Laden an', async () => {
    vi.spyOn(api, 'getProjektKontext').mockRejectedValueOnce(new Error('Nicht lesbar')).mockResolvedValue(data)
    render(<ProjektKontextDialog project="Demo" offen onOpenChange={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Nicht lesbar')
    expect(screen.getByRole('button', { name: 'Speichern' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Erneut laden' }))
    expect(await screen.findByLabelText('Projektwissen')).toHaveValue(data.text)
  })

  it('ignoriert eine verspätete Antwort aus einem anderen Projekt', async () => {
    let finish!: (value: typeof data) => void
    vi.spyOn(api, 'getProjektKontext').mockReturnValueOnce(new Promise(resolve => { finish = resolve })).mockResolvedValue({ ...data, text: 'Zweites Projekt' })
    const view = render(<ProjektKontextDialog project="Alt" offen onOpenChange={vi.fn()} />)
    view.rerender(<ProjektKontextDialog project="Neu" offen onOpenChange={vi.fn()} />)
    expect(await screen.findByLabelText('Projektwissen')).toHaveValue('Zweites Projekt')
    await act(async () => finish(data))
    expect(screen.getByLabelText('Projektwissen')).toHaveValue('Zweites Projekt')
  })

  it('öffnet nach dem Schließen mit frischem Ladezustand und ohne ungespeicherten Text', async () => {
    vi.spyOn(api, 'getProjektKontext').mockResolvedValueOnce(data).mockRejectedValueOnce(new Error('Lesefehler'))
    const view = render(<ProjektKontextDialog project="Demo" offen onOpenChange={vi.fn()} />)
    fireEvent.change(await screen.findByLabelText('Projektwissen'), { target: { value: 'Entwurf' } })
    view.rerender(<ProjektKontextDialog project="Demo" offen={false} onOpenChange={vi.fn()} />)
    view.rerender(<ProjektKontextDialog project="Demo" offen onOpenChange={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Lesefehler')
    expect(screen.queryByLabelText('Projektwissen')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Speichern' })).toBeDisabled()
  })

  it('schließt ein anderes Projekt nicht durch einen verspäteten Save', async () => {
    let finish!: (value: typeof data) => void
    vi.spyOn(api, 'getProjektKontext').mockResolvedValue(data)
    vi.spyOn(api, 'saveProjektKontext').mockReturnValue(new Promise(resolve => { finish = resolve }))
    const close = vi.fn()
    const view = render(<ProjektKontextDialog project="Alt" offen onOpenChange={close} />)
    fireEvent.change(await screen.findByLabelText('Projektwissen'), { target: { value: 'Entwurf' } })
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
    view.rerender(<ProjektKontextDialog project="Neu" offen onOpenChange={close} />)
    expect(await screen.findByLabelText('Projektwissen')).toHaveValue(data.text)
    await act(async () => finish(data))
    expect(close).not.toHaveBeenCalled()
  })
})

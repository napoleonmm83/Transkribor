import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import * as api from '@/lib/api'
import { ProjektEinstellungenDialog } from './ProjektEinstellungenDialog'

const BASIS = {
  sprache: 'ch', korrektur: 'auto', mehrsprachig: false, sprecher_max: 20,
  sprach_choices: [
    { id: 'ch', label: 'Schweizerdeutsch', hint: '' },
    { id: 'en', label: 'Englisch', hint: '' },
  ],
  tiefen: [{ id: 'auto', label: 'Automatisch (aus Sprache)' }, { id: 'voll_dialekt', label: 'Voll' }, { id: 'leicht', label: 'Leicht' }],
}

describe('ProjektEinstellungenDialog', () => {
  it('lädt beim Öffnen und speichert die Sprache', async () => {
    const getSpy = vi.spyOn(api, 'getProjektEinstellungen').mockResolvedValue(BASIS)
    const saveSpy = vi.spyOn(api, 'saveProjektEinstellungen')
      .mockResolvedValue({ sprache: 'en', korrektur: 'auto', mehrsprachig: false })
    const onGeaendert = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <ProjektEinstellungenDialog project="p" offen onOpenChange={onOpenChange} onGeaendert={onGeaendert} />,
    )
    // Select ist gebunden an sprache='ch' → Label steht im Trigger
    await waitFor(() => expect(screen.getByText('Schweizerdeutsch')).toBeInTheDocument())
    // shadcn Select öffnen + Englisch wählen via Trigger. Ueber den NAMEN, nicht ueber „die
    // erste combobox im body": dieser Dialog hat drei, und die Reihenfolge ist kein Vertrag
    // (im Datei-Zwilling wurde sie mit #273 umgestellt).
    fireEvent.click(await screen.findByRole('combobox', { name: 'Sprache' }))
    fireEvent.click(await screen.findByText('Englisch'))
    fireEvent.click(screen.getByText('Speichern'))
    await waitFor(() =>
      expect(saveSpy).toHaveBeenCalledWith('p', expect.objectContaining({ sprache: 'en', korrektur: 'auto' })))
    expect(onGeaendert).toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
    getSpy.mockRestore(); saveSpy.mockRestore()
  })

  it('legt Speichern bei Lade-Fehler still (keine leeren Strings speichern)', async () => {
    const getSpy = vi.spyOn(api, 'getProjektEinstellungen').mockRejectedValue(new Error('boom'))
    render(<ProjektEinstellungenDialog project="p" offen />)
    const save = await screen.findByText('Speichern')
    expect(save).toBeDisabled()
    getSpy.mockRestore()
  })
})

describe('ProjektEinstellungenDialog — mehrsprachig', () => {
  it('lädt den Haken und schickt ihn mit', async () => {
    vi.spyOn(api, 'getProjektEinstellungen').mockResolvedValue({ ...BASIS, mehrsprachig: true })
    const saveSpy = vi.spyOn(api, 'saveProjektEinstellungen')
      .mockResolvedValue({ sprache: 'ch', korrektur: 'auto', mehrsprachig: false })
    render(<ProjektEinstellungenDialog project="p" offen />)
    const kasten = await screen.findByLabelText(/enthält weitere sprachen/i)
    expect(kasten).toBeChecked()                       // Serverwert kommt an
    fireEvent.click(kasten)                            // wieder abwählen
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
    await waitFor(() => expect(saveSpy).toHaveBeenCalledWith(
      'p', expect.objectContaining({ mehrsprachig: false })))
    saveSpy.mockRestore()
  })
})

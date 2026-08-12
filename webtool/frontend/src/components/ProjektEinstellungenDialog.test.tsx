import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import * as api from '@/lib/api'
import { ProjektEinstellungenDialog } from './ProjektEinstellungenDialog'

const BASIS = {
  sprache: 'ch', korrektur: 'auto',
  sprach_choices: [
    { id: 'ch', label: 'Schweizerdeutsch', hint: '' },
    { id: 'en', label: 'Englisch', hint: '' },
  ],
  tiefen: [{ id: 'voll_dialekt', label: 'Voll' }, { id: 'leicht', label: 'Leicht' }],
}

describe('ProjektEinstellungenDialog', () => {
  it('lädt beim Öffnen und speichert die Sprache', async () => {
    const getSpy = vi.spyOn(api, 'getProjektEinstellungen').mockResolvedValue(BASIS)
    const saveSpy = vi.spyOn(api, 'saveProjektEinstellungen')
      .mockResolvedValue({ ...BASIS, sprache: 'en' })
    const onGeaendert = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <ProjektEinstellungenDialog project="p" offen onOpenChange={onOpenChange} onGeaendert={onGeaendert} />,
    )
    // Select ist gebunden an sprache='ch' → Label steht im Trigger
    await waitFor(() => expect(screen.getByText('Schweizerdeutsch')).toBeInTheDocument())
    // shadcn Select öffnen + Englisch wählen via Trigger. Dialog+Select portalen nach
    // document.body, darum container-Query hier wirkungslos — body trifft beide.
    fireEvent.click(document.body.querySelector('[role="combobox"]')!)
    fireEvent.click(await screen.findByText('Englisch'))
    fireEvent.click(screen.getByText('Speichern'))
    await waitFor(() =>
      expect(saveSpy).toHaveBeenCalledWith('p', expect.objectContaining({ sprache: 'en', korrektur: 'auto' })))
    expect(onGeaendert).toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
    getSpy.mockRestore(); saveSpy.mockRestore()
  })
})

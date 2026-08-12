import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import * as api from '@/lib/api'
import { DateiEinstellungenDialog } from './DateiEinstellungenDialog'
import type { ProjectFile } from '@/lib/types'

const BASIS = {
  sprache: 'ch', korrektur: 'auto',
  sprach_choices: [
    { id: 'ch', label: 'Schweizerdeutsch', hint: '' },
    { id: 'en', label: 'Englisch', hint: '' },
  ],
  tiefen: [{ id: 'voll_dialekt', label: 'Voll (mit Dialekt)' }, { id: 'leicht', label: 'Leicht' }],
}
const datei = (p: Partial<ProjectFile> = {}): ProjectFile =>
  ({ base: 'a', has_audio: true, has_raw: true, has_edit: false, has_md: false, ...p })

/** shadcn-Select öffnen: der Trigger portalt nach document.body; container-Query greift nicht. */
const spracheWaehlen = async (label: string) => {
  fireEvent.click(document.body.querySelector('[role="combobox"]')!)
  fireEvent.click(await screen.findByText(label))
}

describe('DateiEinstellungenDialog', () => {
  it('lädt die effektiven Werte und zeigt sie an', async () => {
    const getSpy = vi.spyOn(api, 'getFileEinstellungen').mockResolvedValue(BASIS)
    render(<DateiEinstellungenDialog project="p" base="a" file={datei()} offen />)
    await waitFor(() => expect(screen.getByText('Schweizerdeutsch')).toBeInTheDocument())
    getSpy.mockRestore()
  })

  it('deaktiviert Speichern, solange nichts geändert ist', async () => {
    vi.spyOn(api, 'getFileEinstellungen').mockResolvedValue(BASIS)
    render(<DateiEinstellungenDialog project="p" base="a" file={datei()} offen />)
    expect(await screen.findByText('Speichern')).toBeDisabled()
  })

  it('zeigt bei Sprache-Änderung + has_raw den Transkriptions-Hinweis und den Trigger-Knopf', async () => {
    vi.spyOn(api, 'getFileEinstellungen').mockResolvedValue(BASIS)
    render(<DateiEinstellungenDialog project="p" base="a" file={datei({ has_edit: true })} offen />)
    await screen.findByText('Schweizerdeutsch')
    await spracheWaehlen('Englisch')
    expect(screen.getByText(/erfordert Neu-Transkription/)).toBeInTheDocument()
    expect(screen.getByText(/handbearbeiteten Fassung/)).toBeInTheDocument()   // has_edit
    expect(screen.getByRole('button', { name: 'Speichern & neu transkribieren' })).toBeEnabled()
  })

  it('zeigt bei nur-Tiefe-Änderung den Korrektur-Knopf', async () => {
    vi.spyOn(api, 'getFileEinstellungen').mockResolvedValue(BASIS)
    render(<DateiEinstellungenDialog project="p" base="a" file={datei()} offen />)
    // Readiness-Signal ist der Sprache-Trigger; der Tiefe-Trigger bleibt leer, weil
    // korrektur='auto' in TIEFEN nicht vorkommt (gleiches Verhalten wie der Projekt-Dialog).
    await screen.findByText('Schweizerdeutsch')
    // Tiefe-Select (letzter combobox im Dialog) auf "Leicht" stellen:
    const comboboxes = document.body.querySelectorAll('[role="combobox"]')
    fireEvent.click(comboboxes[comboboxes.length - 1])
    fireEvent.click(await screen.findByText('Leicht'))
    expect(screen.getByRole('button', { name: 'Speichern & neu korrigieren' })).toBeEnabled()
  })

  it('ruft onGespeichert mit den richtigen Flags und speichert nur bei Änderung', async () => {
    const saveSpy = vi.spyOn(api, 'saveFileEinstellungen')
      .mockResolvedValue({ ...BASIS, sprache: 'en' })
    const onGespeichert = vi.fn()
    const onOpenChange = vi.fn()
    vi.spyOn(api, 'getFileEinstellungen').mockResolvedValue(BASIS)
    render(<DateiEinstellungenDialog project="p" base="a" file={datei()} offen
      onOpenChange={onOpenChange} onGespeichert={onGespeichert} />)
    await screen.findByText('Schweizerdeutsch')
    await spracheWaehlen('Englisch')
    fireEvent.click(screen.getByRole('button', { name: 'Speichern & neu transkribieren' }))
    await waitFor(() => expect(saveSpy).toHaveBeenCalledWith('p', 'a', expect.objectContaining({ sprache: 'en' })))
    expect(onGespeichert).toHaveBeenCalledWith({ spracheGeaendert: true, tiefeGeaendert: false })
    expect(onOpenChange).toHaveBeenCalledWith(false)
    saveSpy.mockRestore()
  })

  it('zeigt bei !has_raw den Hinweis zur nächsten Transkription und keinen Trigger-Knopf', async () => {
    vi.spyOn(api, 'getFileEinstellungen').mockResolvedValue(BASIS)
    render(<DateiEinstellungenDialog project="p" base="a" file={datei({ has_raw: false })} offen />)
    await screen.findByText('Schweizerdeutsch')
    await spracheWaehlen('Englisch')
    expect(screen.getByText(/nächsten Transkription/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /neu transkribieren/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Speichern' })).toBeEnabled()
  })
})

import { describe, it, expect, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { UmbenennenDialog, sprecherNamen } from './UmbenennenDialog'
import type { EditDoc } from '@/lib/types'

describe('sprecherNamen', () => {
  it('sammelt jeden Namen einmal, in der Reihenfolge des ersten Auftretens', () => {
    const doc = { segments: [
      { speaker: 'Interviewer' }, { speaker: 'Hans Müller' }, { speaker: 'Hans Müller' },
      { speaker: '' }, { speaker: '   ' }, { speaker: 'Interviewer' },
    ] } as unknown as EditDoc
    expect(sprecherNamen(doc)).toEqual(['Interviewer', 'Hans Müller'])
  })

  it('vertraegt ein fehlendes Dokument', () => {
    expect(sprecherNamen(null)).toEqual([])
  })
})

describe('UmbenennenDialog', () => {
  const zeigen = (extra = {}) => {
    const onSpeichern = vi.fn().mockResolvedValue(undefined)
    render(<UmbenennenDialog offen onOpenChange={vi.fn()} titel="Aufnahme umbenennen"
      beschreibung="egal" wert="01172464" onSpeichern={onSpeichern} {...extra} />)
    return { onSpeichern, feld: screen.getByLabelText('Neuer Name') as HTMLInputElement }
  }

  it('startet mit dem aktuellen Namen im Feld', () => {
    expect(zeigen().feld.value).toBe('01172464')
  })

  it('setzt einen Sprechernamen ins Feld, schickt ihn aber nicht selbst ab', async () => {
    // Der Vorschlag ist eine Abkuerzung, keine Entscheidung — sonst benennt ein Fehlklick um.
    const { onSpeichern, feld } = zeigen({ vorschlaege: ['Interviewer', 'Hans Müller'] })
    await act(async () => { screen.getByRole('button', { name: 'Hans Müller' }).click() })
    expect(feld.value).toBe('Hans Müller')
    expect(onSpeichern).not.toHaveBeenCalled()
    await act(async () => { screen.getByRole('button', { name: 'Umbenennen' }).click() })
    expect(onSpeichern).toHaveBeenCalledWith('Hans Müller')
  })

  it('ruft den Server nicht, wenn sich nichts geaendert hat', async () => {
    const { onSpeichern } = zeigen()
    await act(async () => { screen.getByRole('button', { name: 'Umbenennen' }).click() })
    expect(onSpeichern).not.toHaveBeenCalled()
  })
})

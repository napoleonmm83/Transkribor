import { describe, it, expect, vi } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import { UmbenennenDialog } from './UmbenennenDialog'
import { sprecherNamen } from '@/lib/sprecherNamen'
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

  it('bleibt offen, wenn der Aufrufer abbricht (false)', async () => {
    // Wer die Ungespeichert-Rueckfrage ablehnt, hat NICHT umbenannt — ein Dialog, der sich
    // trotzdem schliesst, behauptet das Gegenteil (CodeRabbit-Fund, PR #90).
    const onOpenChange = vi.fn()
    render(<UmbenennenDialog offen onOpenChange={onOpenChange} titel="t" beschreibung="b"
      wert="alt" onSpeichern={vi.fn().mockResolvedValue(false)} />)
    const feld = screen.getByLabelText('Neuer Name') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!
        .set!.call(feld, 'neu')
      feld.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { screen.getByRole('button', { name: 'Umbenennen' }).click() })
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it('schliesst nicht, wenn der Dialog waehrend des Speicherns zu einem anderen Gegenstand wurde', async () => {
    // Die `stand.active`-Wache hinter dem `await`: `key={wert}` baut den Inhalt fuer einen anderen
    // Gegenstand neu auf, und die Antwort des ALTEN Laufs darf den neuen Dialog weder schliessen
    // noch anfassen. Mutation „Wache raus" -> `onOpenChange(false)` feuert, der Test wird rot.
    let fertig: () => void = () => {}
    const onSpeichern = vi.fn(() => new Promise<void>(r => { fertig = r }))
    const onOpenChange = vi.fn()
    const props = { offen: true, onOpenChange, titel: 't', beschreibung: 'b', onSpeichern }
    const { rerender } = render(<UmbenennenDialog {...props} wert="alt" />)
    fireEvent.change(screen.getByLabelText('Neuer Name'), { target: { value: 'neu' } })
    await act(async () => { screen.getByRole('button', { name: 'Umbenennen' }).click() })
    expect(onSpeichern).toHaveBeenCalledWith('neu')
    rerender(<UmbenennenDialog {...props} wert="anderes" />)
    await act(async () => { fertig() })
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Neuer Name')).toHaveValue('anderes')
  })

  it('ruft den Server nicht, wenn sich nichts geaendert hat', async () => {
    const { onSpeichern } = zeigen()
    await act(async () => { screen.getByRole('button', { name: 'Umbenennen' }).click() })
    expect(onSpeichern).not.toHaveBeenCalled()
  })
})

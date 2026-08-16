import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DokumentFeld } from './DokumentFeld'

// `toast` ist Funktion (der Streich-Hinweis aus `lib/streichen`) UND Namensraum (`toast.info`
// aus `EditierbarerText`, wenn eine Eingabe verworfen wird) — beides muss die Attrappe koennen.
const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { info: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMock }))

/** Die Aktion aus dem zuletzt gezeigten Toast — `undefined`, wenn gar keiner kam. */
const rueckgaengig = () =>
  toastMock.mock.calls.at(-1)?.[1]?.action as { label: string; onClick: () => void } | undefined

/** Leert das Feld ueber den echten Weg: Absatz anklicken, Textarea leeren, Fokus weg. */
function leeren(sichtbar: string) {
  fireEvent.click(screen.getByText(sichtbar))
  const feld = screen.getByRole('textbox')
  fireEvent.change(feld, { target: { value: '' } })
  fireEvent.blur(feld)
}

/**
 * Issue #226: #154 hat Anmerkung und Segment-Notiz einen Rueckweg gegeben — Kontext und
 * Zusammenfassung, die dritte Stelle mit derselben Eigenschaft, blieben aussen vor. Auch dort
 * gibt es keine Zweitschrift, und `context` steht im Export ganz oben.
 */
describe('DokumentFeld', () => {
  it('bietet nach dem Leeren einen Rueckweg an, der den Absatz zurueckschreibt', () => {
    toastMock.mockClear()
    const onCommit = vi.fn()
    render(<DokumentFeld titel="Kontext" wert="Interview im Stall, Juni" platzhalter="…"
      onCommit={onCommit} />)
    leeren('Interview im Stall, Juni')

    expect(onCommit).toHaveBeenCalledWith('')
    const aktion = rueckgaengig()
    expect(aktion?.label).toBe('Rückgängig')
    aktion!.onClick()
    expect(onCommit).toHaveBeenLastCalledWith('Interview im Stall, Juni')
  })

  it('der Toast nennt die Rubrik und den gestrichenen Text', () => {
    // Ohne den Text stehen zwei Streichungen kurz hintereinander als zwei identische Zeilen
    // uebereinander, und welcher Knopf welchen Absatz zurueckholt, ist nicht zu sehen.
    toastMock.mockClear()
    render(<DokumentFeld titel="Zusammenfassung" wert="Es geht um die Hofuebergabe."
      platzhalter="…" onCommit={vi.fn()} />)
    leeren('Es geht um die Hofuebergabe.')
    expect(toastMock.mock.calls.at(-1)![0])
      .toBe('Zusammenfassung „Es geht um die Hofuebergabe.“ gestrichen')
  })

  it('meldet beim blossen Aendern KEINEN Streich-Toast', () => {
    // Gegenprobe: ein Rueckweg, der immer angeboten wird, ist derselbe Schaden von der anderen
    // Seite — Dauerlaerm, bis niemand mehr hinsieht.
    toastMock.mockClear()
    const onCommit = vi.fn()
    render(<DokumentFeld titel="Kontext" wert="alt" platzhalter="…" onCommit={onCommit} />)
    fireEvent.click(screen.getByText('alt'))
    const feld = screen.getByRole('textbox')
    fireEvent.change(feld, { target: { value: 'alt, berichtigt' } })
    fireEvent.blur(feld)

    expect(onCommit).toHaveBeenCalledWith('alt, berichtigt')
    expect(toastMock).not.toHaveBeenCalled()
  })

  it('schreibt beim Streichen `""`, nicht den Leerraum', () => {
    // `TextEditor` vergleicht GETRIMMT und schreibt UNGETRIMMT: ein mit Leerzeichen
    // „geleertes“ Feld kaeme sonst als "   " an — truthy genug, um als Inhalt zu gelten, zu
    // leer, um irgendwo zu erscheinen (`render_md` strippt). Dieselbe Falle wie an PR #153.
    toastMock.mockClear()
    const onCommit = vi.fn()
    render(<DokumentFeld titel="Kontext" wert="etwas" platzhalter="…" onCommit={onCommit} />)
    fireEvent.click(screen.getByText('etwas'))
    const feld = screen.getByRole('textbox')
    fireEvent.change(feld, { target: { value: '   ' } })
    fireEvent.blur(feld)

    expect(onCommit).toHaveBeenCalledWith('')
    expect(rueckgaengig()?.label).toBe('Rückgängig')
  })

  it('sagt im Titel an, dass Leeren streicht — ohne Pronomen', () => {
    // Ohne den Hinweis findet den Weg niemand (es gibt keinen Loeschknopf). Und der Text traegt
    // „Kontext“ (m.) wie „Zusammenfassung“ (w.) — ein Pronomen waere an einem der beiden falsch.
    render(<DokumentFeld titel="Zusammenfassung" wert="x" platzhalter="…" onCommit={vi.fn()} />)
    expect(screen.getByTitle('Zusammenfassung bearbeiten (leeren streicht das Feld)'))
      .toBeInTheDocument()
  })
})

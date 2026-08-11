import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TextEditor } from './TextEditor'

describe('TextEditor', () => {
  it('committet den geänderten Text bei Blur', () => {
    const onCommit = vi.fn()
    render(<TextEditor initial="hallo" onCommit={onCommit} onCancel={vi.fn()} />)
    const ta = screen.getByDisplayValue('hallo')
    fireEvent.change(ta, { target: { value: 'hallo welt' } })
    fireEvent.blur(ta)
    expect(onCommit).toHaveBeenCalledWith('hallo welt')
  })

  it('committet bei ⌘Enter/Ctrl+Enter', () => {
    const onCommit = vi.fn()
    render(<TextEditor initial="hallo" onCommit={onCommit} onCancel={vi.fn()} />)
    const ta = screen.getByDisplayValue('hallo')
    fireEvent.change(ta, { target: { value: 'hallo welt' } })
    fireEvent.keyDown(ta, { key: 'Enter', metaKey: true })
    expect(onCommit).toHaveBeenCalledWith('hallo welt')
  })

  it('bricht bei Escape ab, ohne zu committen', () => {
    const onCommit = vi.fn()
    const onCancel = vi.fn()
    render(<TextEditor initial="hallo" onCommit={onCommit} onCancel={onCancel} />)
    fireEvent.keyDown(screen.getByDisplayValue('hallo'), { key: 'Escape' })
    expect(onCancel).toHaveBeenCalled()
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('unveraendert wieder verlassen ist ein Abbruch, kein Commit', () => {
    // Der Guard gehoert HIERHIN und nicht zu den Aufrufern: `SegmentView` und `DokumentFeld`
    // haetten ihn sonst je einzeln — und einer haette ihn nicht (genau so war es).
    const onCommit = vi.fn(), onCancel = vi.fn()
    render(<TextEditor initial="hallo" onCommit={onCommit} onCancel={onCancel} />)
    fireEvent.blur(screen.getByDisplayValue('hallo'))
    expect(onCommit).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalled()
  })

  it('reiner Leerraum ist keine Aenderung', () => {
    // `render_md` strippt ohnehin — im Export waere nichts anders, ein Schreibvorgang aber
    // setzt human_edited=true. Ein ungetrimmter Vergleich liesse genau das durch.
    const onCommit = vi.fn(), onCancel = vi.fn()
    render(<TextEditor initial="hallo" onCommit={onCommit} onCancel={onCancel} />)
    const ta = screen.getByDisplayValue('hallo')
    fireEvent.change(ta, { target: { value: '  hallo\n' } })
    fireEvent.blur(ta)
    expect(onCommit).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalled()
  })

  it('aber ein leergeraeumtes Feld IST eine Aenderung', () => {
    // Streichen muss moeglich bleiben: ein leerer Kontext ist eine Entscheidung, kein No-op.
    const onCommit = vi.fn()
    render(<TextEditor initial="hallo" onCommit={onCommit} onCancel={vi.fn()} />)
    const ta = screen.getByDisplayValue('hallo')
    fireEvent.change(ta, { target: { value: '' } })
    fireEvent.blur(ta)
    expect(onCommit).toHaveBeenCalledWith('')
  })
  it('ein neu geladener Ausgangswert ersetzt den offenen Feldinhalt', () => {
    // #114: `reload()` tauscht das Dokument aus (fertige Korrektur), schliesst aber keinen
    // offenen Editor. Die Textarea ist unkontrolliert (`defaultValue`) und hielt den ALTEN
    // Stand — der naechste Blur schrieb ihn ueber die frische Korrektur, bei `dirty === false`
    // ohne jede Rueckfrage. Ein `key` am Textfeld baut es beim Wechsel des Ausgangswerts neu auf.
    const onCommit = vi.fn()
    const { rerender } = render(<TextEditor initial="alt" onCommit={onCommit} onCancel={vi.fn()} />)
    rerender(<TextEditor initial="neu" onCommit={onCommit} onCancel={vi.fn()} />)
    expect(screen.getByRole('textbox')).toHaveValue('neu')
    fireEvent.blur(screen.getByRole('textbox'))
    expect(onCommit).not.toHaveBeenCalled()   // Feld == Dokument, es gibt nichts zu schreiben
  })
  it('verwirft dabei Getipptes — bewusst, aber es ist eine Entscheidung', () => {
    // Issue #114 liess die Frage offen. Entschieden zugunsten des Verwerfens: eine fertige
    // Korrektur wiegt schwerer als nicht uebernommene Tastendruecke. Dieser Test haelt die
    // Entscheidung fest, damit sie beim naechsten Lesen nicht wie ein Fehler aussieht.
    const onCommit = vi.fn(), onCancel = vi.fn()
    const { rerender } = render(<TextEditor initial="alt" onCommit={onCommit} onCancel={onCancel} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'meine Handarbeit' } })
    rerender(<TextEditor initial="neu" onCommit={onCommit} onCancel={onCancel} />)
    expect(screen.getByRole('textbox')).toHaveValue('neu')
    expect(onCommit).not.toHaveBeenCalled()   // still verworfen, nicht geschrieben
    expect(onCancel).not.toHaveBeenCalled()
  })
})

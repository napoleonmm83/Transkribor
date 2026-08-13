import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { EditorBrueckeProvider, useEditorBruecke, useEditorMelden, type OffenesDokument } from './useEditorBruecke'

const dok: OffenesDokument = {
  project: 'P', base: 'b', dirty: true, stand: 'offen',
  reload: () => {}, vergiss: () => {},
}

/** Die Leiste-Seite: liest den Ref im Augenblick eines Klicks. Hier gibt sie ihn nach draussen,
 *  damit der Test dasselbe sieht wie die Hülle. */
let bruecke: { current: OffenesDokument | null } | null = null
function Leser() { bruecke = useEditorBruecke(); return null }
function Editor() { useEditorMelden(dok); return null }

function Aufbau({ imEditor }: { imEditor: boolean }) {
  return (
    <EditorBrueckeProvider>
      <Leser />
      {imEditor && <Editor />}
    </EditorBrueckeProvider>
  )
}

describe('useEditorMelden', () => {
  // Issue #75: der Cleanup war am Code eindeutig, hing aber an keinem Test — der Ersatz-Editor
  // in AppShell.test.tsx steht ausserhalb der <Routes> und unmountet nie.
  it('räumt den Ref beim Verlassen des Editors, sonst fragt die Hülle ewig nach', () => {
    const { rerender } = render(<Aufbau imEditor />)
    expect(bruecke?.current).toEqual(dok)

    rerender(<Aufbau imEditor={false} />)
    // Bliebe hier `dirty: true` stehen, fragte die Hülle bei jeder Navigation nach
    // ungespeicherten Änderungen an einem Dokument, das gar nicht mehr offen ist — und
    // `reload()` zeigte auf ein totes Dokument.
    expect(bruecke?.current).toBeNull()
  })

  it('meldet ein neues Dokument an, ohne Dep-Array — der Ref trägt IMMER den frischen Stand', () => {
    // Der Effekt läuft bewusst bei jedem Render (kein Dep-Array): ein vergessener Eintrag wäre
    // ein veralteter `dirty`-Wert, also genau der stille Datenverlust, gegen den es geht.
    function Wechsler({ dirty }: { dirty: boolean }) { useEditorMelden({ ...dok, dirty }); return null }
    const { rerender } = render(<EditorBrueckeProvider><Leser /><Wechsler dirty={false} /></EditorBrueckeProvider>)
    expect(bruecke?.current?.dirty).toBe(false)
    rerender(<EditorBrueckeProvider><Leser /><Wechsler dirty /></EditorBrueckeProvider>)
    expect(bruecke?.current?.dirty).toBe(true)
  })
})

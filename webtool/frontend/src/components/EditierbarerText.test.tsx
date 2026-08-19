import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { EditierbarerText } from './EditierbarerText'

/**
 * Issue #244: Der Hinweis „leeren streicht" stand nur im `title` — ein reiner Maus-Tooltip.
 * Der Knopf traegt Textinhalt (den Absatz selbst), und der gewinnt als Accessible Name;
 * per Tastatur oder Screenreader war der einzige Loeschweg nie zu erfahren. Jetzt haengt er
 * zusaetzlich per `aria-describedby` an einem visuell versteckten Text — dasselbe Muster wie
 * der Geltungssatz am Sprachwaehler (`MehrsprachigKasten`).
 *
 * jsdom sieht das Attribut, nicht seine Wirkung auf den vorgelesenen Namen (steht so in
 * `frontend/CLAUDE.md`) — die Wirkung ist im Browser gegengelesen. Was hier pruefbar ist:
 * die VERBINDUNG (beschriebene id existiert und traegt den Hinweis), dass der Text AUSSERHALB
 * des Knopfes steht (darin wuerde er den Accessible Name verschmutzen — dieselbe Lehre wie
 * beim Erklaertext im `<label>` von `MehrsprachigKasten`), und dass zwei Instanzen keine id
 * teilen (ungueltiges HTML, die Beschreibung landete am falschen Element).
 */
describe('EditierbarerText', () => {
  it('erzaehlt Tastatur und Screenreader den Streich-Hinweis (aria-describedby, #244)', () => {
    render(<div>
      <EditierbarerText wert="Alter Absatz" platzhalter="…"
        titel="Anmerkung bearbeiten (leeren streicht sie)" onCommit={vi.fn()} />
      <EditierbarerText wert="Zweiter Absatz" platzhalter="…"
        titel="Kontext bearbeiten (leeren streicht das Feld)" onCommit={vi.fn()} />
    </div>)
    const knoepfe = screen.getAllByRole('button')
    const ids = knoepfe.map(k => k.getAttribute('aria-describedby'))
    knoepfe.forEach((knopf, i) => {
      expect(ids[i], 'jeder Knopf beschreibt seinen Hinweis').toBeTruthy()
      const hinweis = document.getElementById(ids[i]!)
      expect(hinweis?.textContent, 'der Hinweis traegt den Titel-Text').toBe(knopf.title)
      expect(hinweis?.className).toContain('sr-only')
      expect(knopf.contains(hinweis!), 'der Hinweis steht AUSSERHALB des Knopfes').toBe(false)
    })
    expect(new Set(ids).size, 'zwei Instanzen teilen sich keine id').toBe(ids.length)
  })
})

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Notizen, bloecke } from './Notizen'

describe('bloecke — der Zerleger', () => {
  it('macht aus ## eine Überschrift', () => {
    expect(bloecke('## Der Abspieler bleibt')).toEqual([{ art: 'titel', text: 'Der Abspieler bleibt' }])
  })

  it('fasst die Folgezeilen eines Listenpunkts zu EINEM Punkt zusammen', () => {
    // Der Fall, an dem ein naiver Zeilen-für-Zeile-Renderer scheitert: die echten
    // Release-Notes umbrechen ihre Listenpunkte auf ~95 Zeichen.
    const md = '- Schritt 2 trägt seine Höhe selbst:\n  die `<ul>` rollt.\n- Zweiter Punkt'
    expect(bloecke(md)).toEqual([
      { art: 'liste', punkte: ['Schritt 2 trägt seine Höhe selbst: die `<ul>` rollt.', 'Zweiter Punkt'] },
    ])
  })

  it('fasst die Zeilen eines Absatzes zusammen und trennt an der Leerzeile', () => {
    expect(bloecke('Erste Zeile\nzweite Zeile\n\nNeuer Absatz')).toEqual([
      { art: 'absatz', text: 'Erste Zeile zweite Zeile' },
      { art: 'absatz', text: 'Neuer Absatz' },
    ])
  })

  it('beendet eine Liste an der Leerzeile — die Folgezeile ist kein Listenpunkt mehr', () => {
    expect(bloecke('- Punkt\n\nAbsatz danach')).toEqual([
      { art: 'liste', punkte: ['Punkt'] },
      { art: 'absatz', text: 'Absatz danach' },
    ])
  })

  it('leerer Text ergibt gar nichts', () => {
    expect(bloecke('')).toEqual([])
  })
})

describe('Notizen — die Anzeige', () => {
  it('setzt **fett** und `code` als Auszeichnung, nicht als Sternchen', () => {
    render(<Notizen text={'Im Fenster **„+ Material"** rollte `min-h-0` mit.'} />)
    expect(screen.getByText('„+ Material"').tagName).toBe('STRONG')
    expect(screen.getByText('min-h-0').tagName).toBe('CODE')
    expect(screen.queryByText(/\*\*/)).toBeNull()
  })

  it('zeichnet INNERHALB von fett weiter aus — echte Notizen mischen das', () => {
    // „**Kein `position: sticky`**" steht wortwoertlich in den Notizen zu v0.29.0. Ohne den
    // zweiten Durchgang standen die Backticks sichtbar im fetten Text (im Browser gefunden).
    render(<Notizen text={'- **Kein `position: sticky`** — sonst scheint es durch.'} />)
    expect(screen.getByText('position: sticky').tagName).toBe('CODE')
    expect(screen.queryByText(/`/)).toBeNull()
  })

  it('macht aus [Text](https://…) einen Link', () => {
    render(<Notizen text="Siehe [Issue 281](https://github.com/x/y/issues/281)." />)
    const a = screen.getByRole('link', { name: 'Issue 281' })
    expect(a).toHaveAttribute('href', 'https://github.com/x/y/issues/281')
    expect(a).toHaveAttribute('rel', expect.stringContaining('noreferrer'))
  })

  it('javascript:-Links bleiben Text — die Notizen kommen von einem fremden Server', () => {
    // Trust-Boundary: der Body kommt über HTTP von api.github.com. Ein `href` daraus
    // ungeprüft in ein <a> zu setzen, wäre ein Ausführungsweg.
    render(<Notizen text="[Klick mich](javascript:alert(1))" />)
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText(/Klick mich/)).toBeTruthy()
  })

  it('rendert Überschrift, Liste und Absatz als eigene Elemente', () => {
    render(<Notizen text={'## Titel\n\nEin Absatz.\n\n- Ein Punkt\n- Noch einer'} />)
    expect(screen.getByRole('heading', { name: 'Titel' })).toBeTruthy()
    expect(screen.getByText('Ein Absatz.')).toBeTruthy()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })
})

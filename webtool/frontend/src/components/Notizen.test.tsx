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
      { art: 'liste', nummeriert: false, punkte: ['Schritt 2 trägt seine Höhe selbst: die `<ul>` rollt.', 'Zweiter Punkt'] },
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
      { art: 'liste', nummeriert: false, punkte: ['Punkt'] },
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

describe('bloecke — die Konstrukte, die in ECHTEN Notizen vorkommen', () => {
  // Gezählt über die zehn Fassungen, die die Seite zeigt (`gh api …/releases?per_page=10`):
  // kursiv 25, Trennlinie 4, Nummernliste 3, Zitat 1, Links 0. Die erste Fassung des
  // Renderers kannte drei davon nicht — 6 von 10 Fassungen rendeten deshalb falsch. Diese
  // Tests speisen deshalb echte Auszüge; handgetippte Fixtures bestätigen genau die
  // Annahme, die falsch war.

  it('hält eine Nummernliste zusammen, statt sie zu Fliesstext zu verschmelzen', () => {
    // WÖRTLICH aus v0.26.0. Ohne den Zweig fielen alle Schritte in EINEN Absatz, weil
    // zwischen ihnen keine Leerzeile steht — ausgerechnet die Beschreibung des
    // Material-Dialogs, der Kern jener Fassung.
    const echt = [
      '1. **Aussuchen** — Dateien hineinziehen oder Video-Links einfügen. Beides landet in *einer*',
      '   Liste, du musst dich nicht vorher entscheiden.',
      '2. **Einstellen** — eine Zeile pro Aufnahme.',
    ].join('\n')
    const b = bloecke(echt)
    expect(b).toHaveLength(1)
    expect(b[0]).toMatchObject({ art: 'liste', nummeriert: true })
    expect((b[0] as { punkte: string[] }).punkte).toHaveLength(2)
  })

  it('trennt Aufzählung und Nummernliste, statt sie zu vermischen', () => {
    expect(bloecke('- Punkt\n1. Schritt').map(b => b.art === 'liste' && b.nummeriert))
      .toEqual([false, true])
  })

  it('macht aus --- einen Trenner, nicht einen Absatz mit drei Strichen', () => {
    expect(bloecke('Oben\n\n---\n\nUnten')).toEqual([
      { art: 'absatz', text: 'Oben' }, { art: 'trenner' }, { art: 'absatz', text: 'Unten' },
    ])
  })

  it('nimmt dem Zitat sein >', () => {
    expect(bloecke('> Dateiliste → **⋯-Menü** der Aufnahme')).toEqual([
      { art: 'zitat', text: 'Dateiliste → **⋯-Menü** der Aufnahme' },
    ])
  })
})

describe('Notizen — Auszeichnung an echtem Material', () => {
  it('setzt *kursiv*, statt die Sternchen stehen zu lassen', () => {
    render(<Notizen text={'Beides landet in *einer* Liste.'} />)
    expect(screen.getByText('einer').tagName).toBe('EM')
    expect(screen.queryByText(/\*/)).toBeNull()
  })

  it('zerlegt **fett** NICHT in Kursivbereiche', () => {
    // Die naheliegende Erklärung dafür ist gemessen FALSCH: nicht die Reihenfolge der
    // Alternativen schützt das `**`, sondern `(?![\s*])` — mit vertauschter Reihenfolge
    // bleibt dieser Test grün. Er sichert also das Ergebnis, nicht die Anordnung.
    render(<Notizen text={'**Aussuchen** — Dateien hineinziehen.'} />)
    expect(screen.getByText('Aussuchen').tagName).toBe('STRONG')
    expect(document.querySelectorAll('em')).toHaveLength(0)
  })

  it('hält eine Multiplikation für keine Kursivschrift', () => {
    // Der Satz MIT nachfolgendem Wort („und *so* weiter") ist der falsche Prüfstein: dort
    // fängt schon `(?![*\w])` den Kandidaten ab, und die Mutation „Leerraum-Regel raus"
    // blieb damit grün (gemessen). Scharf wird es, wenn der zweite Stern am Zeilenende
    // steht — dann entscheidet allein der Leerraum davor.
    render(<Notizen text={'5 * 3 = 15 *'} />)
    expect(document.querySelectorAll('em')).toHaveLength(0)
  })

  it('zeichnet trotzdem aus, wo ein Malzeichen daneben steht', () => {
    // Gegenprobe: die Regel darf nicht jede Kursivschrift verschlucken.
    render(<Notizen text={'5 * 3 = 15 und *so* weiter.'} />)
    expect(screen.getByText('so').tagName).toBe('EM')
  })

  it('rendert eine Nummernliste als <ol>', () => {
    render(<Notizen text={'1. Aussuchen\n2. Einstellen'} />)
    expect(document.querySelectorAll('ol > li')).toHaveLength(2)
    expect(document.querySelectorAll('ul')).toHaveLength(0)
  })

  it('rendert --- als <hr> und > als <blockquote>', () => {
    render(<Notizen text={'Oben\n\n---\n\n> Zitat'} />)
    expect(document.querySelectorAll('hr')).toHaveLength(1)
    expect(document.querySelector('blockquote')?.textContent).toBe('Zitat')
  })

  it('kürzt eine URL mit Klammer nicht zu einem falschen Ziel', () => {
    // `[^)]+` brach an der ersten Klammer ab und ergab einen funktionierenden, aber FALSCHEN
    // Link (404) — schlechter als Text, weil er eine Klickfläche hat.
    render(<Notizen text={'[Klammer](https://x/y_(z))'} />)
    expect(screen.getByRole('link', { name: 'Klammer' })).toHaveAttribute('href', 'https://x/y_(z)')
  })
})


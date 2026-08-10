import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, useNavigate } from 'react-router-dom'
import { AppShell } from './AppShell'
import { JobProvider } from '@/hooks/useActiveJob'
import * as api from '@/lib/api'
import type { Settings } from '@/lib/types'

vi.mock('@/lib/api')

describe('AppShell', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(api.getHardware).mockResolvedValue({ device: 'cpu', name: 'CPU', torch_ok: false, asr: 'cpu' })
    // Seit Task 3 traegt AppShell den ProjektDatenProvider -- der ruft beim Mounten selbst.
    vi.mocked(api.listProjects).mockResolvedValue([])
    vi.mocked(api.getProjectFiles).mockResolvedValue({ name: '', files: [] })
    // Seit Task 5 traegt AppShell die Leiste -- die fragt useAiReady (getSettings) fuer den
    // Korrigieren-Knopf. Ungemockt liefert das Automock von '@/lib/api' undefined zurueck,
    // und `.then` darauf wirft in useAiReady.
    vi.mocked(api.getSettings).mockResolvedValue({ ai_ready: true, ai_reason: '' } as Settings)
  })

  it('zeigt den Inhalt und GENAU eine Statuszeile', () => {
    render(
      <MemoryRouter>
        <JobProvider><AppShell><p>Inhalt</p></AppShell></JobProvider>
      </MemoryRouter>,
    )
    expect(screen.getByText('Inhalt')).toBeInTheDocument()
    // contentinfo = <footer>. Zwei davon hiesse: eine Seite bringt ihre eigene mit.
    expect(screen.getAllByRole('contentinfo')).toHaveLength(1)
  })

  it('setzt den Bildlauf beim Routenwechsel zurueck', () => {
    // jsdom implementiert Element.scrollTo nicht — die Attrappe am Prototyp ist der einzige
    // Weg, den Aufruf hier zu sehen. Gemessen wird der Aufruf, nicht die Wirkung.
    const scrollTo = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { value: scrollTo, configurable: true, writable: true })
    function Springen() {
      const navigate = useNavigate()
      return <button onClick={() => navigate('/einstellungen')}>weiter</button>
    }
    render(
      <MemoryRouter initialEntries={['/']}>
        <JobProvider><AppShell><Springen /></AppShell></JobProvider>
      </MemoryRouter>,
    )
    scrollTo.mockClear()                  // der erste Lauf des Effekts zaehlt nicht
    fireEvent.click(screen.getByText('weiter'))
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 })
  })

  it('zeigt die Seitenleiste mit den Projekten', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([{ name: 'Alpha', dateien: 1, fertig: 0, geaendert: 0 }])
    vi.mocked(api.getProjectFiles).mockResolvedValue({ name: 'Alpha', files: [] })
    render(
      <MemoryRouter initialEntries={['/']}>
        <JobProvider><AppShell><p>Inhalt</p></AppShell></JobProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByRole('navigation', { name: 'Projekte' })).toBeInTheDocument())
    expect(screen.getByText('Alpha')).toBeInTheDocument()
  })

  it('bietet einen Sprunglink VOR der Leiste', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <JobProvider><AppShell><p>Inhalt</p></AppShell></JobProvider>
      </MemoryRouter>,
    )
    const sprung = screen.getByRole('link', { name: 'Zum Inhalt' })
    expect(sprung).toHaveAttribute('href', '#inhalt')
    // Reihenfolge im DOM ist hier die ganze Aussage: hinter der Leiste waere der Link
    // wertlos, weil man ihn erst nach dreihundert Knoepfen erreicht.
    const leiste = screen.getByRole('navigation', { name: 'Projekte' })
    expect(sprung.compareDocumentPosition(leiste) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

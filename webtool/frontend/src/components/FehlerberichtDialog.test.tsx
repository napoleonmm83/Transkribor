import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FehlerberichtDialog } from './FehlerberichtDialog'

afterEach(cleanup)

it('FehlerberichtDialog zeigt die Vorschau und meldet bestätigten Versand', async () => {
  const senden = vi.fn().mockResolvedValue({ id: 'bericht-1' })
  render(<FehlerberichtDialog offen schliessen={vi.fn()}
    vorschau={() => Promise.resolve({ id: 'bericht-1', kopf: ['Transkribor 1.0'], zeilen: ['Fehler'] })}
    senden={senden} />)
  expect(await screen.findByText('Fehler')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /An Bugsink senden/ }))
  expect(await screen.findByRole('status')).toHaveTextContent('angenommen')
  expect(senden).toHaveBeenCalledWith('bericht-1', [0], '')
})

it('FehlerberichtDialog meldet ohne bestätigende Antwort keinen Erfolg', async () => {
  render(<FehlerberichtDialog offen schliessen={vi.fn()}
    vorschau={() => Promise.resolve({ id: 'bericht-1', kopf: [], zeilen: [] })}
    senden={() => Promise.resolve(undefined)} />)
  fireEvent.click(await screen.findByRole('button', { name: /An Bugsink senden/ }))
  expect(await screen.findByRole('alert')).toHaveTextContent('nicht bestätigt')
  expect(screen.queryByRole('status')).toBeNull()
})

// Kalt-Review 24.09.: der Transport hat keine eigene Frist; ein haengender Versand sperrte
// beide Knoepfe und Escape bis zum Neustart.
// Electron setzt vor jede Ablehnung ueber ipcRenderer.invoke ein technisches Praefix; gemessen in
// der gepackten App stand es woertlich im Dialog.
it('FehlerberichtDialog zeigt die Meldung ohne Electrons IPC-Praefix', async () => {
  render(<FehlerberichtDialog offen schliessen={vi.fn()}
    vorschau={() => Promise.resolve({ id: 'bericht-1', kopf: [], zeilen: [] })}
    senden={() => Promise.reject(new Error("Error invoking remote method 'fehlerbericht:senden': Error: Zu viele Berichte in kurzer Zeit."))} />)
  fireEvent.click(await screen.findByRole('button', { name: /An Bugsink senden/ }))
  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent(/^Zu viele Berichte in kurzer Zeit\.$/)
  // Rueckrichtung: nach dem Fehlschlag sendet nichts mehr — kein Hinweis, wieder „Abbrechen".
  expect(screen.queryByText(/Versand läuft weiter/)).toBeNull()
  expect(screen.getByRole('button', { name: 'Abbrechen' })).toBeTruthy()
})

it('FehlerberichtDialog laesst sich waehrend des Sendens schliessen', async () => {
  const schliessen = vi.fn()
  render(<FehlerberichtDialog offen schliessen={schliessen}
    vorschau={() => Promise.resolve({ id: 'bericht-1', kopf: [], zeilen: ['Fehler'] })}
    senden={() => new Promise(() => {})} />)
  expect(await screen.findByRole('button', { name: 'Abbrechen' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /An Bugsink senden/ }))
  // CodeRabbit an PR #641: der Versand laeuft im Hauptprozess weiter — „Abbrechen" versprach, was
  // nicht geschieht, und lud zum Doppelbericht ein. Vor dem Senden bleibt es beim Abbrechen.
  expect(screen.queryByRole('button', { name: 'Abbrechen' })).toBeNull()
  expect(screen.getByText(/Versand läuft weiter/)).toBeTruthy()
  const zu = screen.getByRole('button', { name: 'Schliessen' })
  expect(zu).toBeEnabled()
  fireEvent.click(zu)
  expect(schliessen).toHaveBeenCalled()
})

it('FehlerberichtDialog: die spaete Antwort eines abgebrochenen Versands erreicht den neu geoeffneten Dialog nicht', async () => {
  let spaet: (v: { id: string }) => void = () => {}
  const senden = vi.fn().mockReturnValueOnce(new Promise(r => { spaet = r }))
  const props = { schliessen: vi.fn(), senden,
    vorschau: () => Promise.resolve({ id: 'bericht-1', kopf: [], zeilen: ['Fehler'] }) }
  const { rerender } = render(<FehlerberichtDialog offen {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: /An Bugsink senden/ }))
  rerender(<FehlerberichtDialog offen={false} {...props} />)
  rerender(<FehlerberichtDialog offen {...props} />)
  expect(await screen.findByRole('button', { name: /An Bugsink senden/ })).toBeEnabled()
  spaet({ id: 'bericht-1' })
  await new Promise(r => setTimeout(r, 0))
  expect(screen.queryByRole('status')).toBeNull()
})

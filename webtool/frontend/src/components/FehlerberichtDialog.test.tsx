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

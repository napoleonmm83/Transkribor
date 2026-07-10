import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { DeleteProjectDialog } from './DeleteProjectDialog'
import * as api from '@/lib/api'
vi.mock('@/lib/api')
describe('DeleteProjectDialog', () => {
  it('Löschen erst nach exakt eingetipptem Namen; ruft deleteProject', async () => {
    vi.mocked(api.deleteProject).mockResolvedValue(undefined)
    const onDeleted = vi.fn()
    render(<DeleteProjectDialog project="Demo" onDeleted={onDeleted} />)
    fireEvent.click(screen.getByLabelText(/Projekt Demo l/))
    const btn = await screen.findByRole('button', { name: /^L/ })
    expect(btn).toBeDisabled()
    fireEvent.change(screen.getByLabelText(/Projektname best/), { target: { value: 'Demo' } })
    expect(btn).not.toBeDisabled()
    fireEvent.click(btn)
    await waitFor(() => expect(api.deleteProject).toHaveBeenCalledWith('Demo'))
  })
})

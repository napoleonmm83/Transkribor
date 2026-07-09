import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SpeakerCombobox } from './SpeakerCombobox'

describe('SpeakerCombobox', () => {
  it('übernimmt Freitext bei Enter', () => {
    const onChange = vi.fn()
    render(<SpeakerCombobox value="" options={['Interviewer']} onChange={onChange} />)
    fireEvent.click(screen.getByText('Sprecher…'))
    const input = screen.getByPlaceholderText('Sprecher…')
    fireEvent.change(input, { target: { value: 'Neuer Sprecher' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('Neuer Sprecher')
  })
})

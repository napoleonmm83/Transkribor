import { describe, it, expect } from 'vitest'
import { audioUrl } from './api'

describe('audioUrl', () => {
  it('encodiert Projekt und base', () => {
    expect(audioUrl('Food Festival', 'C0687/x')).toBe(
      '/api/projects/Food%20Festival/audio/C0687%2Fx')
  })
})

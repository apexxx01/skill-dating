import { describe, it, expect } from 'vitest'
import { recommendationType } from './recommend'

describe('recommendationType', () => {
  it('is the first type the viewer chose that is not dating', () => {
    expect(recommendationType(['MENTEE', 'COFOUNDER'])).toBe('MENTEE')
    expect(recommendationType(['DATING', 'HACKATHON_TEAMMATE'])).toBe('HACKATHON_TEAMMATE')
  })

  it('keeps dating out of every other surface: a plain collaboration for somebody who chose only dating or nothing', () => {
    expect(recommendationType(['DATING'])).toBe('COLLABORATOR')
    expect(recommendationType([])).toBe('COLLABORATOR')
  })
})

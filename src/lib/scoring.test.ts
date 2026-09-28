import { describe, it, expect } from 'vitest'
import { calculateSkillCompatibility } from './scoring'

describe('calculateSkillCompatibility', () => {
  it('returns 0 when either side has no skills', () => {
    expect(calculateSkillCompatibility([], [{ skillId: 's1', level: 3, category: 'Engineering' }]).score).toBe(0)
    expect(calculateSkillCompatibility([{ skillId: 's1', level: 3, category: 'Engineering' }], []).score).toBe(0)
    expect(calculateSkillCompatibility([], []).score).toBe(0)
  })

  it('is symmetric: compatibility(a, b) === compatibility(b, a)', () => {
    const a = [
      { skillId: 'react', level: 5, category: 'Engineering' },
      { skillId: 'figma', level: 2, category: 'Design' },
    ]
    const b = [
      { skillId: 'react', level: 3, category: 'Engineering' },
      { skillId: 'ml', level: 4, category: 'AI/ML' },
    ]
    expect(calculateSkillCompatibility(a, b).score).toBe(calculateSkillCompatibility(b, a).score)
  })

  it('scores identical maxed-out skill sets highly on overlap', () => {
    const skills = [
      { skillId: 'react', level: 5, category: 'Engineering' },
      { skillId: 'node', level: 5, category: 'Engineering' },
    ]
    const { score, commonSkillIds } = calculateSkillCompatibility(skills, skills)
    expect(commonSkillIds.sort()).toEqual(['node', 'react'])
    expect(score).toBeGreaterThan(50)
  })

  it('rewards complementary categories over pure duplication', () => {
    const frontend = [{ skillId: 'react', level: 5, category: 'Engineering' }]
    const design = [{ skillId: 'figma', level: 5, category: 'Design' }]
    const duplicateFrontend = [{ skillId: 'react2', level: 5, category: 'Engineering' }]

    const complementary = calculateSkillCompatibility(frontend, design).score
    const sameCategoryNoOverlap = calculateSkillCompatibility(frontend, duplicateFrontend).score

    expect(complementary).toBeGreaterThan(sameCategoryNoOverlap)
  })

  it('never returns a score outside [0, 99]', () => {
    const huge = Array.from({ length: 50 }, (_, i) => ({ skillId: `s${i}`, level: 5, category: 'Engineering' }))
    const { score } = calculateSkillCompatibility(huge, huge)
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(99)
  })

  it('is order-independent for common skill detection regardless of level mismatch', () => {
    const a = [{ skillId: 'react', level: 1, category: 'Engineering' }]
    const b = [{ skillId: 'react', level: 5, category: 'Engineering' }]
    expect(calculateSkillCompatibility(a, b).commonSkillIds).toEqual(['react'])
  })
})

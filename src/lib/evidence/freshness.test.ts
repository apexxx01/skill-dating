import { describe, it, expect } from 'vitest'
import { freshnessLabel, freshnessOf, freshnessView } from './freshness'
import { mainLanguages, skillSlugsFor } from './skill-map'
import { DEFAULT_FRESHNESS, freshnessSettingSchema } from './strength-config'

const MONTH = 30.4375 * 24 * 60 * 60 * 1000
const now = new Date('2026-10-29T00:00:00Z')
const ago = (months: number) => new Date(now.getTime() - months * MONTH)

describe('skill freshness', () => {
  it('halves every half-life', () => {
    expect(freshnessOf(now, now)).toBe(1)
    expect(freshnessOf(ago(18), now)).toBe(0.5)
    expect(freshnessOf(ago(36), now)).toBe(0.25)
    expect(freshnessOf(ago(9), now, { ...DEFAULT_FRESHNESS, halfLifeMonths: 9 })).toBe(0.5)
    // Evidence dated in the future (a clock skew) is simply fresh.
    expect(freshnessOf(new Date(now.getTime() + MONTH), now)).toBe(1)
    expect(freshnessOf(null, now)).toBeNull()
  })

  it('labels ACTIVE, then WARM, then RUSTY as the evidence ages', () => {
    expect(freshnessView(ago(1), now).label).toBe('ACTIVE')
    expect(freshnessView(ago(9), now).label).toBe('ACTIVE')
    expect(freshnessView(ago(12), now).label).toBe('WARM')
    expect(freshnessView(ago(30), now).label).toBe('WARM')
    expect(freshnessView(ago(33), now).label).toBe('RUSTY')
    expect(freshnessView(null, now)).toEqual({ lastEvidencedAt: null, freshness: null, label: null })
    expect(freshnessLabel(0.68)).toBe('ACTIVE')
    expect(freshnessLabel(0.3)).toBe('WARM')
    expect(freshnessLabel(0.29)).toBe('RUSTY')
  })

  it('refuses a setting whose labels are the wrong way round', () => {
    expect(freshnessSettingSchema.safeParse(DEFAULT_FRESHNESS).success).toBe(true)
    expect(freshnessSettingSchema.safeParse({ ...DEFAULT_FRESHNESS, activeAtLeast: 0.2, warmAtLeast: 0.5 }).success).toBe(false)
  })
})

describe('skill mapping', () => {
  it('maps known languages and topics to existing skill slugs and ignores the rest', () => {
    expect(skillSlugsFor({ languages: ['TypeScript', 'Brainfuck'], topics: ['nextjs', 'React', 'my-cool-thing', 'postgres'] })).toEqual(['nextjs', 'postgresql', 'react', 'typescript'])
    expect(skillSlugsFor({ languages: [], topics: [] })).toEqual([])
    // Several tags for one skill give it once.
    expect(skillSlugsFor({ languages: ['Go'], topics: ['golang'] })).toEqual(['go'])
  })

  it('takes only the languages that are a real part of the code', () => {
    expect(mainLanguages({ TypeScript: 9000, CSS: 500, Shell: 100, Python: 2000 })).toEqual(['TypeScript', 'Python'])
    expect(mainLanguages({ A: 1, B: 1, C: 1, D: 1 })).toEqual(['A', 'B', 'C'])
    expect(mainLanguages({})).toEqual([])
  })
})

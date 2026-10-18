import { describe, it, expect } from 'vitest'
import { ROMANCE_COMPONENTS, ROMANCE_SCORE_CONFIG, scoreRomance, type RomanceScoringProfile } from './score'

const profile = (over: Partial<RomanceScoringProfile> = {}): RomanceScoringProfile => ({
  userId: 'a',
  ambition: 3,
  direction: 'founder',
  rhythm: 'night-owl',
  obsessions: ['climate tech'],
  techStack: ['rust'],
  endorsers: 0,
  ...over,
})
const score = (viewer: Partial<RomanceScoringProfile>, candidate: Partial<RomanceScoringProfile>) => scoreRomance({ viewer: profile(viewer), candidate: profile({ userId: 'b', ...candidate }) })

describe('the affinity tables', () => {
  it('are keyed with the two names in alphabetical order, and cover every different pair of rhythms', () => {
    for (const key of [...Object.keys(ROMANCE_SCORE_CONFIG.directionAffinity), ...Object.keys(ROMANCE_SCORE_CONFIG.rhythmAffinity)]) {
      const [a, b] = key.split('|')
      expect(a < b, key).toBe(true)
    }
    const rhythms = ['night-owl', 'early-bird', 'bursty', 'steady']
    for (const a of rhythms) for (const b of rhythms) if (a < b) expect(ROMANCE_SCORE_CONFIG.rhythmAffinity[`${a}|${b}`], `${a}|${b}`).toBeGreaterThan(0)
  })

  it('are symmetric in use', () => {
    const rhythms = ['night-owl', 'early-bird', 'bursty', 'steady'] as const
    for (const a of rhythms) for (const b of rhythms) expect(score({ rhythm: a }, { rhythm: b }).components.rhythm.value).toBe(score({ rhythm: b }, { rhythm: a }).components.rhythm.value)
    const directions = ['founder', 'craft', 'research', 'steady-career', 'nomad', 'open'] as const
    for (const a of directions) for (const b of directions) expect(score({ direction: a }, { direction: b }).components.direction.value).toBe(score({ direction: b }, { direction: a }).components.direction.value)
  })
})

describe('the weights', () => {
  it('add up to 100, one per component', () => {
    expect(Object.keys(ROMANCE_SCORE_CONFIG.weights).sort()).toEqual([...ROMANCE_COMPONENTS].sort())
    expect(Object.values(ROMANCE_SCORE_CONFIG.weights).reduce((a, b) => a + b, 0)).toBe(100)
  })

  it('put what people are obsessed with first and the vouching of other builders next to the direction of their life', () => {
    const w = ROMANCE_SCORE_CONFIG.weights
    expect(w.obsessions).toBeGreaterThan(w.direction)
    expect(w.direction).toBeGreaterThan(w.rhythm)
    expect(w.character).toBeGreaterThanOrEqual(w.sharedTaste)
  })
})

describe('scoreRomance', () => {
  it('is a whole number from 0 to 100, with a component for each weight', () => {
    const result = score({}, {})
    expect(Number.isInteger(result.score)).toBe(true)
    expect(result.score).toBeGreaterThanOrEqual(0)
    expect(result.score).toBeLessThanOrEqual(100)
    expect(Object.keys(result.components).sort()).toEqual([...ROMANCE_COMPONENTS].sort())
    expect(ROMANCE_COMPONENTS.reduce((sum, key) => sum + result.components[key].weight, 0)).toBeCloseTo(100, 9)
  })

  it('is deterministic', () => {
    expect(score({}, { obsessions: ['climate tech', 'rust'] })).toEqual(score({}, { obsessions: ['climate tech', 'rust'] }))
  })

  it('scores alike people higher than unalike ones', () => {
    const alike = score({}, {})
    const unalike = score({}, { ambition: 1, direction: 'steady-career', rhythm: 'early-bird', obsessions: ['wine'], techStack: ['cobol'], endorsers: 0 })
    expect(alike.score).toBeGreaterThan(unalike.score)
  })

  it('rewards each part on its own', () => {
    const base = score({}, { ambition: 1, direction: 'nomad', rhythm: 'early-bird', obsessions: ['wine'], techStack: ['cobol'] }).score
    expect(score({}, { ambition: 3, direction: 'nomad', rhythm: 'early-bird', obsessions: ['wine'], techStack: ['cobol'] }).score).toBeGreaterThan(base)
    expect(score({}, { ambition: 1, direction: 'founder', rhythm: 'early-bird', obsessions: ['wine'], techStack: ['cobol'] }).score).toBeGreaterThan(base)
    expect(score({}, { ambition: 1, direction: 'nomad', rhythm: 'night-owl', obsessions: ['wine'], techStack: ['cobol'] }).score).toBeGreaterThan(base)
    expect(score({}, { ambition: 1, direction: 'nomad', rhythm: 'early-bird', obsessions: ['climate tech'], techStack: ['cobol'] }).score).toBeGreaterThan(base)
    expect(score({}, { ambition: 1, direction: 'nomad', rhythm: 'early-bird', obsessions: ['wine'], techStack: ['rust'] }).score).toBeGreaterThan(base)
    expect(score({}, { ambition: 1, direction: 'nomad', rhythm: 'early-bird', obsessions: ['wine'], techStack: ['cobol'], endorsers: 5 }).score).toBeGreaterThan(base)
  })

  it('treats ambition by distance on the scale', () => {
    const at = (candidate: number) => score({ ambition: 1 }, { ambition: candidate }).components.ambition.value
    expect(at(1)).toBe(1)
    expect(at(2)).toBeCloseTo(2 / 3, 9)
    expect(at(4)).toBe(0)
  })

  it('treats rhythm: the same is best, and a night owl and an early bird are the furthest apart', () => {
    const at = (candidate: 'night-owl' | 'early-bird' | 'bursty' | 'steady') => score({ rhythm: 'night-owl' }, { rhythm: candidate }).components.rhythm.value
    expect(at('night-owl')).toBe(1)
    expect(at('early-bird')).toBeLessThan(at('steady'))
    expect(at('early-bird')).toBeLessThan(at('bursty'))
  })

  it('treats direction: the same is best, being open is half way, anything else is a little', () => {
    const at = (candidate: 'founder' | 'craft' | 'open' | 'nomad') => score({ direction: 'founder' }, { direction: candidate }).components.direction.value
    expect(at('founder')).toBe(1)
    expect(at('open')).toBe(ROMANCE_SCORE_CONFIG.directionOpenFloor)
    expect(at('craft')).toBe(0.6)
    expect(at('nomad')).toBe(0.55)
    expect(score({ direction: 'steady-career' }, { direction: 'nomad' }).components.direction.value).toBe(0.25)
  })

  it('is symmetric except for the character of the candidate: vouching counts for the one being looked at', () => {
    const a = profile({ userId: 'a', endorsers: 5 })
    const b = profile({ userId: 'b', endorsers: 0 })
    const forwards = scoreRomance({ viewer: a, candidate: b })
    const backwards = scoreRomance({ viewer: b, candidate: a })
    expect(backwards.score).toBeGreaterThan(forwards.score)
    // Everything else is the same either way.
    for (const key of ROMANCE_COMPONENTS.filter((key) => key !== 'character')) expect(forwards.components[key].value).toBe(backwards.components[key].value)
  })

  it('counts a component with nothing to compare as neutral and says it is unknown', () => {
    const result = score({ obsessions: [] }, { obsessions: ['rust'] })
    expect(result.components.obsessions).toMatchObject({ value: ROMANCE_SCORE_CONFIG.neutral, known: false })
    const noStack = score({ techStack: [] }, {})
    expect(noStack.components.sharedTaste).toMatchObject({ value: ROMANCE_SCORE_CONFIG.neutral, known: false })
  })

  it('matches obsessions and tech without regard to case or spacing', () => {
    const result = score({ obsessions: [' Climate Tech '], techStack: ['RUST'] }, { obsessions: ['climate tech'], techStack: ['rust'] })
    expect(result.components.obsessions.value).toBeCloseTo(1 / 3, 9)
    expect(result.components.sharedTaste.value).toBeCloseTo(1 / 3, 9)
  })

  it('gives a full score for three shared obsessions', () => {
    const topics = ['climate tech', 'rust', 'mechanical keyboards']
    expect(score({ obsessions: topics }, { obsessions: topics }).components.obsessions.value).toBe(1)
  })

  it('never uses a professional component: no skills, hours or time zones', () => {
    expect(Object.keys(score({}, {}).components)).not.toContain('skillComplement')
    expect(Object.keys(score({}, {}).components)).not.toContain('timezoneOverlap')
  })
})

describe('the reasons', () => {
  it('says the sentence the product promises when rhythm and a topic are shared', () => {
    const result = score({ obsessions: ['climate tech'] }, { obsessions: ['climate tech'] })
    expect(result.reasons[0]).toBe("You're both night-owl builders obsessed with climate tech")
  })

  it('names up to two shared obsessions in the sentence', () => {
    const topics = ['rust', 'climate tech', 'keyboards']
    const result = score({ obsessions: topics }, { obsessions: topics })
    expect(result.reasons[0]).toBe("You're both night-owl builders obsessed with climate tech and keyboards")
  })

  it('says only what is true: shared topics without a shared rhythm, or a shared rhythm without topics', () => {
    expect(score({ obsessions: ['rust'] }, { obsessions: ['rust'], rhythm: 'early-bird' }).reasons[0]).toBe("You're both obsessed with rust")
    expect(score({ obsessions: ['rust'] }, { obsessions: ['wine'] }).reasons).toContain("You're both night-owl builders")
    expect(score({ obsessions: ['rust'] }, { obsessions: ['wine'], rhythm: 'steady' }).reasons.join(' ')).not.toMatch(/obsessed|builders$/)
  })

  it('adds direction, ambition, shared tech and vouching, strongest first, at most three', () => {
    const result = score({ obsessions: ['rust'] }, { obsessions: ['rust'], endorsers: 4 })
    expect(result.reasons.length).toBeLessThanOrEqual(3)
    expect(result.reasons[0]).toContain('obsessed with rust')
    expect(result.reasons).toContain('You both want to start a company')
    const direct = score({}, { obsessions: ['wine'], rhythm: 'steady', endorsers: 4, techStack: ['cobol'], ambition: 1, direction: 'nomad' })
    expect(direct.reasons).toEqual(['4 builders vouch for them'])
  })

  it('does not say a thing about the private filters', () => {
    const text = JSON.stringify(score({}, {}))
    expect(text).not.toMatch(/gender|woman|man\b|age|city|country|scope/i)
  })
})

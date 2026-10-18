import { describe, it, expect } from 'vitest'
import {
  calculateSkillCompatibility,
  COMPONENTS,
  effectiveWeights,
  exclusionOf,
  SCORE_CONFIG,
  scoreCompatibility,
  timezoneOverlapHours,
  type ComponentKey,
  type ScoreInput,
  type ScoringProfile,
} from './score'

const now = new Date('2026-10-16T12:00:00Z')
const DAY = 24 * 60 * 60 * 1000

function profile(over: Partial<ScoringProfile> = {}): ScoringProfile {
  return {
    userId: 'u',
    connectionTypes: ['COFOUNDER'],
    intentTags: [],
    hoursPerWeek: null,
    availableFrom: null,
    remoteOk: true,
    cityOnly: false,
    lookingForSkills: [],
    workingStyle: {},
    skills: [],
    techStack: [],
    utcOffsetMinutes: null,
    cityKey: null,
    city: null,
    proof: { verifiedEvidence: 0, tier: 'BRONZE', shipped: 0, endorsements: 0 },
    activity: { streak: 0, lastActiveAt: null, lastXpAt: null },
    ...over,
  }
}

const skill = (slug: string, level = 3, evidence = 0, name = slug.toUpperCase()) => ({ slug, name, level, evidence })

function input(viewer: Partial<ScoringProfile>, candidate: Partial<ScoringProfile>, over: Partial<ScoreInput> = {}): ScoreInput {
  return { viewer: profile({ userId: 'v', ...viewer }), candidate: profile({ userId: 'c', ...candidate }), connectionType: 'COFOUNDER', now, ...over }
}

const score = (...args: Parameters<typeof input>) => scoreCompatibility(input(...args))
const component = (result: ReturnType<typeof score>, key: ComponentKey) => result.components[key]

describe('SCORE_CONFIG', () => {
  it('weights add up to exactly 100', () => {
    expect(COMPONENTS.reduce((sum, key) => sum + SCORE_CONFIG.weights[key], 0)).toBe(100)
    expect(Object.keys(SCORE_CONFIG.weights).sort()).toEqual([...COMPONENTS].sort())
  })

  it('has no negative weight or multiplier', () => {
    for (const weight of Object.values(SCORE_CONFIG.weights)) expect(weight).toBeGreaterThan(0)
    for (const multipliers of Object.values(SCORE_CONFIG.typeMultipliers)) for (const value of Object.values(multipliers)) expect(value).toBeGreaterThan(0)
  })
})

describe('effectiveWeights', () => {
  const all = Object.fromEntries(COMPONENTS.map((key) => [key, true])) as Record<ComponentKey, boolean>

  it('are the config weights for a type with no multipliers', () => {
    const weights = effectiveWeights('COFOUNDER', all)
    for (const key of COMPONENTS) expect(weights[key], key).toBeCloseTo(SCORE_CONFIG.weights[key], 9)
  })

  it('always add up to 100, however many components apply and whatever the type', () => {
    const noLocation = { ...all, location: false }
    for (const type of ['COFOUNDER', 'HACKATHON_TEAMMATE', 'COLLABORATOR', 'MENTOR', 'MENTEE'] as const) {
      for (const applicable of [all, noLocation]) {
        const total = COMPONENTS.reduce((sum, key) => sum + effectiveWeights(type, applicable)[key], 0)
        expect(total).toBeCloseTo(100, 9)
      }
    }
  })

  it('gives a component that does not apply no weight and scales the others up', () => {
    const weights = effectiveWeights('COFOUNDER', { ...all, location: false })
    expect(weights.location).toBe(0)
    expect(weights.skillComplement).toBeCloseTo((22 / 95) * 100, 9)
  })

  it('moves weight with the type: a mentee looks at what a mentor has shown, a mentor at drive', () => {
    const base = effectiveWeights('COFOUNDER', all)
    expect(effectiveWeights('MENTEE', all).proofStrength).toBeGreaterThan(base.proofStrength)
    expect(effectiveWeights('MENTEE', all).skillOverlap).toBeLessThan(base.skillOverlap)
    expect(effectiveWeights('MENTOR', all).proofStrength).toBeLessThan(base.proofStrength)
    expect(effectiveWeights('MENTOR', all).activityRecency).toBeGreaterThan(base.activityRecency)
  })
})

describe('timezoneOverlapHours', () => {
  it('is the whole window for the same zone', () => {
    expect(timezoneOverlapHours(0, 0)).toBe(10)
    expect(timezoneOverlapHours(330, 330)).toBe(10)
  })

  it('shrinks by the gap between the zones, and is symmetric', () => {
    expect(timezoneOverlapHours(0, 240)).toBe(6)
    expect(timezoneOverlapHours(240, 0)).toBe(6)
    expect(timezoneOverlapHours(0, 330)).toBe(4.5)
    expect(timezoneOverlapHours(-480, 330)).toBe(0)
  })

  it('is 0 when the days do not meet, also across the date line', () => {
    expect(timezoneOverlapHours(0, 600)).toBe(0)
    expect(timezoneOverlapHours(-660, 780)).toBe(timezoneOverlapHours(780, -660))
    expect(timezoneOverlapHours(-660, 780)).toBeGreaterThanOrEqual(0)
  })

  it('wraps around the day: UTC+14 and UTC-10 are 24 hours apart, so they share the same hours', () => {
    expect(timezoneOverlapHours(840, -600)).toBe(10)
  })
})

describe('exclusionOf', () => {
  it('excludes someone blocked, and someone passed within the cooldown', () => {
    expect(exclusionOf({ blocked: true }, now)).toBe('BLOCKED')
    expect(exclusionOf({ passedAt: new Date(now.getTime() - 29 * DAY) }, now)).toBe('PASSED_RECENTLY')
  })

  it('lets someone passed longer ago back in, and a clean history through', () => {
    expect(exclusionOf({ passedAt: new Date(now.getTime() - 31 * DAY) }, now)).toBeUndefined()
    expect(exclusionOf({ passedAt: new Date(now.getTime() - 30 * DAY) }, now)).toBeUndefined()
    expect(exclusionOf(undefined, now)).toBeUndefined()
    expect(exclusionOf({ buildDateRating: 5, passedAt: null }, now)).toBeUndefined()
  })

  it('puts blocked before passed', () => {
    expect(exclusionOf({ blocked: true, passedAt: new Date(now.getTime() - DAY) }, now)).toBe('BLOCKED')
  })
})

describe('scoreCompatibility: the shape', () => {
  it('returns a whole number from 0 to 100, every component and at most three reasons', () => {
    const result = score(
      { skills: [skill('react', 4), skill('ml', 2)], lookingForSkills: ['ml'] },
      { skills: [skill('ml', 5, 3), skill('react', 4)], lookingForSkills: ['react'], proof: { verifiedEvidence: 4, tier: 'GOLD', shipped: 6, endorsements: 5 } }
    )
    expect(Number.isInteger(result.score)).toBe(true)
    expect(result.score).toBeGreaterThanOrEqual(0)
    expect(result.score).toBeLessThanOrEqual(100)
    expect(Object.keys(result.components).sort()).toEqual([...COMPONENTS].sort())
    expect(result.reasons.length).toBeLessThanOrEqual(3)
    expect(result.excluded).toBeUndefined()
  })

  it('is deterministic', () => {
    const a = input({ skills: [skill('react')], lookingForSkills: ['go'] }, { skills: [skill('go', 4, 2)], utcOffsetMinutes: 60 }, { prior: { buildDateRating: 4 } })
    expect(scoreCompatibility(a)).toEqual(scoreCompatibility(a))
  })

  it('has component points that add up to the score before rounding', () => {
    const result = score({ skills: [skill('react', 5)], hoursPerWeek: 10, utcOffsetMinutes: 0 }, { skills: [skill('react', 4)], hoursPerWeek: 20, utcOffsetMinutes: 120 })
    const total = COMPONENTS.reduce((sum, key) => sum + result.components[key].points, 0)
    expect(result.score).toBe(Math.round(total))
    for (const key of COMPONENTS) {
      const c = result.components[key]
      expect(c.value).toBeGreaterThanOrEqual(0)
      expect(c.value).toBeLessThanOrEqual(1)
      expect(c.points).toBeCloseTo(c.value * c.weight, 9)
    }
  })

  it('scores a blocked or recently passed candidate 0 with nothing else', () => {
    const blocked = score({ skills: [skill('react')] }, { skills: [skill('react')] }, { prior: { blocked: true } })
    expect(blocked).toMatchObject({ score: 0, reasons: [], excluded: 'BLOCKED' })
    expect(COMPONENTS.every((key) => blocked.components[key].points === 0)).toBe(true)
    expect(score({}, {}, { prior: { passedAt: new Date(now.getTime() - 2 * DAY) } }).excluded).toBe('PASSED_RECENTLY')
  })

  it('gives two empty profiles the neutral score, not 0 and not 100', () => {
    const result = score({}, {})
    expect(result.score).toBeGreaterThan(10)
    expect(result.score).toBeLessThan(60)
    expect(result.reasons).toEqual([])
    // Everything that needs both sides to have said something is unknown, and counts as the neutral value.
    for (const key of ['skillComplement', 'skillOverlap', 'sharedStack', 'intentMatch', 'commitmentFit', 'timezoneOverlap', 'workingStyle', 'priorSignal'] as const) {
      expect(component(result, key), key).toMatchObject({ known: false, value: SCORE_CONFIG.neutral })
    }
  })

  it('reaches 100 for a perfect match on every component', () => {
    const best = {
      skills: [skill('react', 5, 5), skill('go', 5, 5)],
      lookingForSkills: ['react', 'go'],
      techStack: ['react', 'go', 'postgres'],
      intentTags: [{ tag: 'ship-mvp-90-days' }],
      hoursPerWeek: 20,
      availableFrom: new Date('2026-11-01T00:00:00Z'),
      utcOffsetMinutes: 0,
      workingStyle: { pace: 'steady', communication: 'async', planning: 'light', decisions: 'owners', rhythm: 'daytime', risk: 'timebox' },
      proof: { verifiedEvidence: 5, tier: 'MYTHIC' as const, shipped: 5, endorsements: 10 },
      activity: { streak: 14, lastActiveAt: now, lastXpAt: now },
    }
    const result = score(best, best, { prior: { buildDateRating: 5 } })
    expect(result.score).toBe(100)
  })
})

describe('skillComplement', () => {
  it('rewards having what the viewer is looking for', () => {
    const has = score({ lookingForSkills: ['ml'] }, { skills: [skill('ml', 5)] })
    const lacks = score({ lookingForSkills: ['ml'] }, { skills: [skill('design', 5)] })
    expect(component(has, 'skillComplement').value).toBeGreaterThan(component(lacks, 'skillComplement').value)
    expect(component(lacks, 'skillComplement').value).toBe(0)
    expect(component(has, 'skillComplement').value).toBe(1)
  })

  it('counts both directions: what they have for you and what you have for them', () => {
    const oneWay = score({ lookingForSkills: ['ml'], skills: [skill('react', 5)] }, { skills: [skill('ml', 5)] })
    const bothWays = score({ lookingForSkills: ['ml'], skills: [skill('react', 5)] }, { skills: [skill('ml', 5)], lookingForSkills: ['react'] })
    expect(component(oneWay, 'skillComplement').value).toBe(1)
    expect(component(bothWays, 'skillComplement').value).toBe(1)
    const half = score({ lookingForSkills: ['ml'], skills: [skill('react', 5)] }, { skills: [skill('ml', 5)], lookingForSkills: ['rust'] })
    expect(component(half, 'skillComplement').value).toBe(0.5)
  })

  it('weighs a higher level more, and a partly covered list less', () => {
    const low = score({ lookingForSkills: ['ml'] }, { skills: [skill('ml', 1)] })
    const high = score({ lookingForSkills: ['ml'] }, { skills: [skill('ml', 5)] })
    expect(component(high, 'skillComplement').value).toBeGreaterThan(component(low, 'skillComplement').value)
    const partial = score({ lookingForSkills: ['ml', 'go'] }, { skills: [skill('ml', 5)] })
    expect(component(partial, 'skillComplement').value).toBe(0.5)
  })

  it('is unknown, and neutral, when nobody said what they are looking for', () => {
    const result = score({ skills: [skill('react')] }, { skills: [skill('ml')] })
    expect(component(result, 'skillComplement')).toMatchObject({ known: false, value: SCORE_CONFIG.neutral })
  })

  it('explains it with the proof behind the skill: "You need ML, they have 3 verified ML projects"', () => {
    const result = score({ lookingForSkills: ['ml'] }, { skills: [skill('ml', 4, 3, 'ML')] })
    expect(result.reasons[0]).toBe('You need ML, they have 3 verified ML projects')
  })

  it('says "1 verified ML project" in the singular, and falls back to the level without proof', () => {
    expect(score({ lookingForSkills: ['ml'] }, { skills: [skill('ml', 4, 1, 'ML')] }).reasons[0]).toBe('You need ML, they have 1 verified ML project')
    expect(score({ lookingForSkills: ['ml'] }, { skills: [skill('ml', 4, 0, 'ML')] }).reasons[0]).toBe('You need ML, they have it at level 4')
  })

  it('names the skill they are looking for that you have, when that is the only link', () => {
    const result = score({ skills: [skill('react', 5, 0, 'React')] }, { lookingForSkills: ['react'] })
    expect(result.reasons).toContain('They are looking for React, which you have')
  })

  it('picks the best-evidenced skill when several are wanted', () => {
    const result = score({ lookingForSkills: ['ml', 'go'] }, { skills: [skill('ml', 5, 1, 'ML'), skill('go', 3, 4, 'Go')] })
    expect(result.reasons[0]).toBe('You need Go, they have 4 verified Go projects')
  })
})

describe('skillOverlap', () => {
  it('is the closeness of the skills both have, relative to the smaller list', () => {
    const same = score({ skills: [skill('react', 5)] }, { skills: [skill('react', 5)] })
    expect(component(same, 'skillOverlap').value).toBe(1)
    const lower = score({ skills: [skill('react', 5)] }, { skills: [skill('react', 2)] })
    expect(component(lower, 'skillOverlap').value).toBeCloseTo(0.4, 9)
    const none = score({ skills: [skill('react', 5)] }, { skills: [skill('ml', 5)] })
    expect(component(none, 'skillOverlap')).toMatchObject({ value: 0, known: true })
  })

  it('is unknown when either has no skills', () => {
    expect(component(score({}, { skills: [skill('react')] }), 'skillOverlap').known).toBe(false)
    expect(component(score({ skills: [skill('react')] }, {}), 'skillOverlap').known).toBe(false)
  })

  it('names the two they share best', () => {
    const result = score(
      { skills: [skill('react', 5, 0, 'React'), skill('ts', 4, 0, 'TypeScript'), skill('go', 2, 0, 'Go')] },
      { skills: [skill('react', 5, 0, 'React'), skill('ts', 4, 0, 'TypeScript'), skill('go', 2, 0, 'Go')] }
    )
    expect(result.reasons).toContain('You both know React and TypeScript')
  })
})

describe('sharedStack', () => {
  it('compares technologies without caring about case or spaces, three shared being a full score', () => {
    const result = score({ techStack: ['React', ' Next.js ', 'Postgres', 'Go'] }, { techStack: ['react', 'NEXT.JS', 'postgres'] })
    expect(component(result, 'sharedStack').value).toBe(1)
    expect(result.reasons).toContain('You both build with Next.js, Postgres and React')
  })

  it('scales with how many are shared', () => {
    expect(component(score({ techStack: ['react', 'go'] }, { techStack: ['react', 'rust'] }), 'sharedStack').value).toBeCloseTo(1 / 3, 9)
    expect(component(score({ techStack: ['react'] }, { techStack: ['rust'] }), 'sharedStack')).toMatchObject({ value: 0, known: true })
  })

  it('is unknown when either has none (or only blanks)', () => {
    expect(component(score({ techStack: ['react'] }, {}), 'sharedStack').known).toBe(false)
    expect(component(score({ techStack: ['  '] }, { techStack: ['react'] }), 'sharedStack').known).toBe(false)
  })
})

describe('intentMatch', () => {
  it('is the share of the smaller list that both have', () => {
    const both = score({ intentTags: [{ tag: 'ship-mvp-90-days' }, { tag: 'open-source' }] }, { intentTags: [{ tag: 'ship-mvp-90-days' }, { tag: 'weekend-project' }] })
    expect(component(both, 'intentMatch').value).toBe(0.5)
    const none = score({ intentTags: [{ tag: 'open-source' }] }, { intentTags: [{ tag: 'weekend-project' }] })
    expect(component(none, 'intentMatch')).toMatchObject({ value: 0, known: true })
  })

  it('is unknown when either has no tags', () => {
    expect(component(score({ intentTags: [{ tag: 'open-source' }] }, {}), 'intentMatch').known).toBe(false)
  })

  it('ignores a tag that has expired', () => {
    const expired = score({ intentTags: [{ tag: 'open-source', expiresAt: '2026-10-01T00:00:00Z' }] }, { intentTags: [{ tag: 'open-source' }] })
    expect(component(expired, 'intentMatch').known).toBe(false)
    const live = score({ intentTags: [{ tag: 'open-source', expiresAt: '2026-11-01T00:00:00Z' }] }, { intentTags: [{ tag: 'open-source' }] })
    expect(component(live, 'intentMatch').value).toBe(1)
  })

  it('matches a hackathon tag only for the same hackathon', () => {
    const same = score({ intentTags: [{ tag: 'win-a-hackathon', hackathonId: 'h1' }] }, { intentTags: [{ tag: 'win-a-hackathon', hackathonId: 'h1' }] })
    expect(component(same, 'intentMatch').value).toBe(1)
    expect(same.reasons).toContain('Both are going for the same hackathon')
    const other = score({ intentTags: [{ tag: 'win-a-hackathon', hackathonId: 'h1' }] }, { intentTags: [{ tag: 'win-a-hackathon', hackathonId: 'h2' }] })
    expect(component(other, 'intentMatch').value).toBe(0)
    const unbound = score({ intentTags: [{ tag: 'win-a-hackathon' }] }, { intentTags: [{ tag: 'win-a-hackathon', hackathonId: 'h1' }] })
    expect(component(unbound, 'intentMatch').value).toBe(0)
  })

  it('says it in words: a known tag has its own line, any other is shown as its words', () => {
    expect(score({ intentTags: [{ tag: 'ship-by-year-end' }] }, { intentTags: [{ tag: 'ship-by-year-end' }] }).reasons).toContain('Both want to ship by year end')
    expect(score({ intentTags: [{ tag: 'rust-and-wasm' }] }, { intentTags: [{ tag: 'rust-and-wasm' }] }).reasons).toContain('Both are into rust and wasm')
  })
})

describe('commitmentFit', () => {
  it('is the ratio of the hours a week', () => {
    expect(component(score({ hoursPerWeek: 10 }, { hoursPerWeek: 10 }), 'commitmentFit').value).toBe(1)
    expect(component(score({ hoursPerWeek: 10 }, { hoursPerWeek: 20 }), 'commitmentFit').value).toBe(0.5)
    expect(component(score({ hoursPerWeek: 40 }, { hoursPerWeek: 4 }), 'commitmentFit').value).toBeCloseTo(0.1, 9)
  })

  it('looks at when they can start, within two weeks being the same and three months apart being nothing', () => {
    const start = new Date('2026-11-01T00:00:00Z')
    const at = (days: number) => new Date(start.getTime() + days * DAY)
    expect(component(score({ availableFrom: start }, { availableFrom: at(14) }), 'commitmentFit').value).toBe(1)
    expect(component(score({ availableFrom: start }, { availableFrom: at(90) }), 'commitmentFit').value).toBe(0)
    expect(component(score({ availableFrom: start }, { availableFrom: at(52) }), 'commitmentFit').value).toBeCloseTo(0.5, 9)
  })

  it('combines the two, the hours counting four times as much', () => {
    const start = new Date('2026-11-01T00:00:00Z')
    const result = score({ hoursPerWeek: 10, availableFrom: start }, { hoursPerWeek: 20, availableFrom: new Date(start.getTime() + 200 * DAY) })
    expect(component(result, 'commitmentFit').value).toBeCloseTo(0.8 * 0.5 + 0.2 * 0, 9)
  })

  it('is unknown without hours or dates on both sides', () => {
    expect(component(score({ hoursPerWeek: 10 }, {}), 'commitmentFit').known).toBe(false)
    expect(component(score({ hoursPerWeek: 0 }, { hoursPerWeek: 0 }), 'commitmentFit').known).toBe(false)
  })

  it('says so when the hours are close', () => {
    expect(score({ hoursPerWeek: 15 }, { hoursPerWeek: 15 }).reasons).toContain('You both have about 15h a week')
    expect(score({ hoursPerWeek: 10 }, { hoursPerWeek: 12 }).reasons).toContain('Similar time to give: 10h and 12h a week')
    expect(score({ hoursPerWeek: 5 }, { hoursPerWeek: 20 }).reasons).toEqual([])
  })
})

describe('timezoneOverlap', () => {
  it('is the overlapping hours over six, capped at 1', () => {
    expect(component(score({ utcOffsetMinutes: 0 }, { utcOffsetMinutes: 0 }), 'timezoneOverlap').value).toBe(1)
    expect(component(score({ utcOffsetMinutes: 0 }, { utcOffsetMinutes: 240 }), 'timezoneOverlap').value).toBe(1)
    expect(component(score({ utcOffsetMinutes: 0 }, { utcOffsetMinutes: 420 }), 'timezoneOverlap').value).toBeCloseTo(0.5, 9)
    expect(component(score({ utcOffsetMinutes: 0 }, { utcOffsetMinutes: 600 }), 'timezoneOverlap').value).toBe(0)
  })

  it('is unknown when either zone is not known', () => {
    expect(component(score({ utcOffsetMinutes: 0 }, {}), 'timezoneOverlap').known).toBe(false)
    expect(component(score({}, {}), 'timezoneOverlap').known).toBe(false)
  })

  it('says the hours: "6h timezone overlap"', () => {
    expect(score({ utcOffsetMinutes: 0 }, { utcOffsetMinutes: 240 }).reasons).toContain('6h timezone overlap')
    expect(score({ utcOffsetMinutes: 0 }, { utcOffsetMinutes: 330 }).reasons).toContain('4.5h timezone overlap')
  })

  it('says nothing for a short overlap', () => {
    expect(score({ utcOffsetMinutes: 0 }, { utcOffsetMinutes: 480 }).reasons.some((reason) => reason.includes('timezone'))).toBe(false)
  })
})

describe('location', () => {
  it('does not apply unless somebody asked to meet in a city, and then takes no weight', () => {
    const result = score({ cityKey: 'pune' }, { cityKey: 'berlin' })
    expect(component(result, 'location')).toMatchObject({ applicable: false, weight: 0, points: 0 })
    const total = COMPONENTS.reduce((sum, key) => sum + result.components[key].weight, 0)
    expect(total).toBeCloseTo(100, 9)
  })

  it('applies when either side wants the same city, and is 1 only for the same one', () => {
    const same = score({ cityOnly: true, cityKey: 'pune', city: 'Pune' }, { cityKey: 'pune', city: 'Pune' })
    expect(component(same, 'location')).toMatchObject({ applicable: true, value: 1 })
    expect(same.reasons).toContain('Both based in Pune')
    const other = score({ cityKey: 'pune' }, { cityOnly: true, cityKey: 'berlin' })
    expect(component(other, 'location')).toMatchObject({ applicable: true, value: 0 })
  })

  it('does not count an unknown city as a match', () => {
    expect(component(score({ cityOnly: true }, { cityKey: 'pune' }), 'location').value).toBe(0)
    expect(component(score({ cityOnly: true }, {}), 'location').value).toBe(0)
  })
})

describe('workingStyle', () => {
  it('is how alike the answers are on the questions both answered', () => {
    const same = score({ workingStyle: { pace: 'steady', rhythm: 'night' } }, { workingStyle: { pace: 'steady', rhythm: 'night' } })
    expect(component(same, 'workingStyle').value).toBe(1)
    const opposite = score({ workingStyle: { pace: 'steady' } }, { workingStyle: { pace: 'sprints' } })
    expect(component(opposite, 'workingStyle').value).toBe(0)
    const neighbour = score({ workingStyle: { pace: 'steady' } }, { workingStyle: { pace: 'balanced' } })
    expect(component(neighbour, 'workingStyle').value).toBe(0.5)
  })

  it('is unknown without a question both answered', () => {
    expect(component(score({ workingStyle: { pace: 'steady' } }, { workingStyle: { rhythm: 'night' } }), 'workingStyle').known).toBe(false)
    expect(component(score({}, {}), 'workingStyle').known).toBe(false)
  })

  it('says what they share when at least two answers are the same', () => {
    const same = { pace: 'steady', communication: 'async', rhythm: 'night' }
    expect(score({ workingStyle: same }, { workingStyle: same }).reasons).toContain('You work alike: the same pace, way of communicating and working hours')
    expect(score({ workingStyle: { pace: 'steady' } }, { workingStyle: { pace: 'steady' } }).reasons.some((reason) => reason.startsWith('You work alike'))).toBe(false)
  })
})

describe('proofStrength', () => {
  it('rises with verified evidence, tier, shipped projects and endorsements, and is 0 for none of them', () => {
    expect(component(score({}, {}), 'proofStrength').value).toBe(0)
    const some = component(score({}, { proof: { verifiedEvidence: 2, tier: 'BRONZE', shipped: 0, endorsements: 0 } }), 'proofStrength').value
    const more = component(score({}, { proof: { verifiedEvidence: 5, tier: 'BRONZE', shipped: 0, endorsements: 0 } }), 'proofStrength').value
    const tier = component(score({}, { proof: { verifiedEvidence: 5, tier: 'GOLD', shipped: 0, endorsements: 0 } }), 'proofStrength').value
    expect(some).toBeLessThan(more)
    expect(more).toBeLessThan(tier)
    expect(component(score({}, { proof: { verifiedEvidence: 99, tier: 'MYTHIC', shipped: 99, endorsements: 99 } }), 'proofStrength').value).toBe(1)
  })

  it('reads the candidate only, not the viewer', () => {
    const strongViewer = score({ proof: { verifiedEvidence: 9, tier: 'MYTHIC', shipped: 9, endorsements: 9 } }, {})
    expect(component(strongViewer, 'proofStrength').value).toBe(0)
  })

  it('says what they have shown', () => {
    expect(score({}, { proof: { verifiedEvidence: 0, tier: 'GOLD', shipped: 4, endorsements: 0 } }).reasons).toContain('They have shipped 4 projects')
    expect(score({}, { proof: { verifiedEvidence: 1, tier: 'SILVER', shipped: 1, endorsements: 0 } }).reasons).toContain('They have 1 verified proof of their work')
    expect(score({}, { proof: { verifiedEvidence: 3, tier: 'SILVER', shipped: 0, endorsements: 0 } }).reasons).toContain('They have 3 verified proofs of their work')
  })
})

describe('activityRecency', () => {
  it('is highest for someone active today with a long streak and fades over 30 days', () => {
    const live = component(score({}, { activity: { streak: 14, lastActiveAt: now, lastXpAt: now } }), 'activityRecency').value
    const week = component(score({}, { activity: { streak: 0, lastActiveAt: new Date(now.getTime() - 7 * DAY), lastXpAt: null } }), 'activityRecency').value
    const stale = component(score({}, { activity: { streak: 0, lastActiveAt: new Date(now.getTime() - 40 * DAY), lastXpAt: new Date(now.getTime() - 40 * DAY) } }), 'activityRecency').value
    expect(live).toBe(1)
    expect(week).toBeGreaterThan(stale)
    expect(stale).toBe(0)
  })

  it('mentions a streak of a week or more', () => {
    expect(score({}, { activity: { streak: 9, lastActiveAt: now, lastXpAt: now } }).reasons).toContain('They are on a 9-day streak')
    expect(score({}, { activity: { streak: 3, lastActiveAt: now, lastXpAt: now } }).reasons).toEqual([])
  })

  it('reads the candidate only', () => {
    const result = score({ activity: { streak: 30, lastActiveAt: now, lastXpAt: now } }, {})
    expect(component(result, 'activityRecency').value).toBe(0)
  })
})

describe('priorSignal', () => {
  it('maps a Build Date rating of 1 to 5 onto 0 to 1, and is unknown without one', () => {
    expect(component(score({}, {}, { prior: { buildDateRating: 1 } }), 'priorSignal').value).toBe(0)
    expect(component(score({}, {}, { prior: { buildDateRating: 3 } }), 'priorSignal').value).toBe(0.5)
    expect(component(score({}, {}, { prior: { buildDateRating: 5 } }), 'priorSignal').value).toBe(1)
    expect(component(score({}, {}), 'priorSignal').known).toBe(false)
    expect(component(score({}, {}, { prior: { buildDateRating: null } }), 'priorSignal').known).toBe(false)
  })

  it('mentions a high rating only', () => {
    expect(score({}, {}, { prior: { buildDateRating: 5 } }).reasons).toContain('You rated a past Build Date with them highly')
    expect(score({}, {}, { prior: { buildDateRating: 2 } }).reasons).toEqual([])
  })

  it('moves the score the right way', () => {
    expect(score({}, {}, { prior: { buildDateRating: 5 } }).score).toBeGreaterThan(score({}, {}, { prior: { buildDateRating: 1 } }).score)
  })
})

describe('the type of relationship', () => {
  const pair = {
    viewer: { skills: [skill('react', 5)], workingStyle: { pace: 'steady' } },
    candidate: { skills: [skill('react', 5)], workingStyle: { pace: 'steady' }, proof: { verifiedEvidence: 5, tier: 'GOLD' as const, shipped: 5, endorsements: 5 } },
  }

  it('changes the score for the same two people', () => {
    const cofounder = scoreCompatibility(input(pair.viewer, pair.candidate, { connectionType: 'COFOUNDER' }))
    const mentee = scoreCompatibility(input(pair.viewer, pair.candidate, { connectionType: 'MENTEE' }))
    expect(mentee.score).not.toBe(cofounder.score)
    expect(component(mentee, 'proofStrength').weight).toBeGreaterThan(component(cofounder, 'proofStrength').weight)
    expect(component(mentee, 'skillOverlap').weight).toBeLessThan(component(cofounder, 'skillOverlap').weight)
  })

  it('still adds the weights up to 100 for every type', () => {
    for (const type of ['COFOUNDER', 'HACKATHON_TEAMMATE', 'COLLABORATOR', 'MENTOR', 'MENTEE'] as const) {
      const result = scoreCompatibility(input(pair.viewer, pair.candidate, { connectionType: type }))
      expect(COMPONENTS.reduce((sum, key) => sum + result.components[key].weight, 0)).toBeCloseTo(100, 9)
    }
  })
})

describe('reasons', () => {
  const strong = {
    viewer: { lookingForSkills: ['ml'], skills: [skill('react', 5, 0, 'React')], hoursPerWeek: 15, utcOffsetMinutes: 0, intentTags: [{ tag: 'ship-by-year-end' }] },
    candidate: {
      skills: [skill('ml', 5, 3, 'ML'), skill('react', 5, 0, 'React')],
      lookingForSkills: ['react'],
      hoursPerWeek: 15,
      utcOffsetMinutes: 240,
      intentTags: [{ tag: 'ship-by-year-end' }],
      proof: { verifiedEvidence: 3, tier: 'GOLD' as const, shipped: 4, endorsements: 2 },
    },
  }

  it('keeps the three strongest, strongest first', () => {
    const result = score(strong.viewer, strong.candidate)
    expect(result.reasons).toHaveLength(3)
    expect(result.reasons[0]).toBe('You need ML, they have 3 verified ML projects')
    expect(result.reasons).toContain('Both want to ship by year end')
  })

  it('never says more than three, however many things line up', () => {
    const all = { ...strong.candidate, techStack: ['react', 'go', 'postgres'], workingStyle: { pace: 'steady', communication: 'async', rhythm: 'night' }, activity: { streak: 20, lastActiveAt: now, lastXpAt: now } }
    const result = score({ ...strong.viewer, techStack: ['react', 'go', 'postgres'], workingStyle: { pace: 'steady', communication: 'async', rhythm: 'night' } }, all, { prior: { buildDateRating: 5 } })
    expect(result.reasons).toHaveLength(3)
  })

  it('says nothing that is not true: no reason without data behind it', () => {
    expect(score({}, {}).reasons).toEqual([])
    expect(score({ skills: [skill('react')] }, { skills: [skill('go')] }).reasons).toEqual([])
  })

  it('uses "they", never a guess at a pronoun', () => {
    const result = score(strong.viewer, strong.candidate)
    for (const reason of result.reasons) expect(reason).not.toMatch(/\b(she|he|her|his|him)\b/i)
  })

  it('leaves out a reason from a component that does not apply', () => {
    const result = score({ techStack: [] }, {})
    expect(result.reasons.some((reason) => reason.startsWith('Both based in'))).toBe(false)
  })
})

describe('symmetry and the viewer’s side', () => {
  it('scores the skill match the same from either side for a symmetric relationship', () => {
    const a = { skills: [skill('react', 4)], lookingForSkills: ['go'], hoursPerWeek: 10, utcOffsetMinutes: 0, techStack: ['react'] }
    const b = { skills: [skill('go', 5)], lookingForSkills: ['react'], hoursPerWeek: 20, utcOffsetMinutes: 180, techStack: ['react', 'go'] }
    const ab = scoreCompatibility(input(a, b))
    const ba = scoreCompatibility(input(b, a))
    for (const key of ['skillComplement', 'skillOverlap', 'sharedStack', 'commitmentFit', 'timezoneOverlap'] as const) {
      expect(component(ab, key).value, key).toBeCloseTo(component(ba, key).value, 9)
    }
  })

  it('judges proof and activity on the candidate, so they differ with the direction', () => {
    const strong = { proof: { verifiedEvidence: 5, tier: 'GOLD' as const, shipped: 5, endorsements: 5 } }
    expect(score({}, strong).score).toBeGreaterThan(score(strong, {}).score)
  })
})

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

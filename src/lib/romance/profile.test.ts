import { describe, it, expect } from 'vitest'
import { profileColumns, romanceProfileSchema, scopeProblems, toOwnProfile, toPublicProfile, type StoredRomanceProfile } from './profile'

const valid = {
  promptObsessed: 'Distributed systems that fail gracefully and the people who debug them at 3am.',
  promptBuild: 'A small open source tool that makes grid-scale batteries easier to schedule.',
  promptWeekend: 'Ship a tiny weekend project together, then eat way too much street food.',
  ambition: 3,
  direction: 'founder',
  rhythm: 'night-owl',
  obsessions: ['Climate Tech', ' rust ', 'mechanical keyboards'],
  gender: 'WOMAN',
  interestedIn: ['MAN', 'NON_BINARY'],
  ageMin: 26,
  ageMax: 38,
  scope: 'COUNTRY',
}

describe('the request schema', () => {
  it('accepts a full profile and tidies the obsessions', () => {
    const result = romanceProfileSchema.safeParse(valid)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.obsessions).toEqual(['climate tech', 'rust', 'mechanical keyboards'])
      expect(result.data.minEndorsements).toBe(0)
      expect(result.data.paused).toBe(false)
      expect(result.data.genderSelfDescribe).toBeNull()
    }
  })

  it('needs each answer to be a real answer', () => {
    expect(romanceProfileSchema.safeParse({ ...valid, promptObsessed: 'too short' }).success).toBe(false)
    expect(romanceProfileSchema.safeParse({ ...valid, promptBuild: 'x'.repeat(501) }).success).toBe(false)
    expect(romanceProfileSchema.safeParse({ ...valid, promptWeekend: '   ' }).success).toBe(false)
  })

  it('keeps the vocabulary closed', () => {
    for (const bad of [{ ambition: 0 }, { ambition: 5 }, { ambition: 2.5 }, { direction: 'tycoon' }, { rhythm: 'afternoon' }, { gender: 'ROBOT' }, { scope: 'PLANET' }, { interestedIn: ['MAN', 'ROBOT'] }]) {
      expect(romanceProfileSchema.safeParse({ ...valid, ...bad }).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('never lets the age range go below 18 or invert', () => {
    expect(romanceProfileSchema.safeParse({ ...valid, ageMin: 17 }).success).toBe(false)
    expect(romanceProfileSchema.safeParse({ ...valid, ageMin: 18, ageMax: 18 }).success).toBe(true)
    expect(romanceProfileSchema.safeParse({ ...valid, ageMin: 30, ageMax: 29 }).success).toBe(false)
    expect(romanceProfileSchema.safeParse({ ...valid, ageMax: 100 }).success).toBe(false)
  })

  it('limits the inbox gate to 0 to 5', () => {
    expect(romanceProfileSchema.safeParse({ ...valid, minEndorsements: 5 }).success).toBe(true)
    expect(romanceProfileSchema.safeParse({ ...valid, minEndorsements: 6 }).success).toBe(false)
    expect(romanceProfileSchema.safeParse({ ...valid, minEndorsements: -1 }).success).toBe(false)
  })

  it('needs interestedIn to be non-empty and without repeats', () => {
    expect(romanceProfileSchema.safeParse({ ...valid, interestedIn: [] }).success).toBe(false)
    expect(romanceProfileSchema.safeParse({ ...valid, interestedIn: ['MAN', 'MAN'] }).success).toBe(false)
  })

  it('takes a self-description only with the self-described gender, and then requires it', () => {
    expect(romanceProfileSchema.safeParse({ ...valid, gender: 'SELF_DESCRIBED' }).success).toBe(false)
    expect(romanceProfileSchema.safeParse({ ...valid, gender: 'SELF_DESCRIBED', genderSelfDescribe: 'agender' }).success).toBe(true)
    expect(romanceProfileSchema.safeParse({ ...valid, gender: 'MAN', genderSelfDescribe: 'agender' }).success).toBe(false)
  })

  it('limits and tidies the obsessions', () => {
    expect(romanceProfileSchema.safeParse({ ...valid, obsessions: Array.from({ length: 13 }, (_, i) => `topic ${i}`) }).success).toBe(false)
    expect(romanceProfileSchema.safeParse({ ...valid, obsessions: ['rust', 'Rust'] }).success).toBe(false)
    expect(romanceProfileSchema.safeParse({ ...valid, obsessions: ['<script>'] }).success).toBe(false)
    expect(romanceProfileSchema.safeParse({ ...valid, obsessions: ['c++', 'f#', 'r&d'] }).success).toBe(true)
    expect(romanceProfileSchema.safeParse({ ...valid, obsessions: ['x'] }).success).toBe(false)
  })

  it('refuses a field it does not know', () => {
    expect(romanceProfileSchema.safeParse({ ...valid, photos: [] }).success).toBe(false)
  })
})

describe('views', () => {
  const now = new Date('2026-10-18T10:00:00Z')
  const row: StoredRomanceProfile = {
    id: 'r1',
    userId: 'u1',
    promptObsessed: valid.promptObsessed,
    promptBuild: valid.promptBuild,
    promptWeekend: valid.promptWeekend,
    ambition: 3,
    direction: 'founder',
    rhythm: 'night-owl',
    obsessions: ['rust'],
    gender: 'WOMAN',
    genderSelfDescribe: null,
    interestedIn: ['MAN'],
    ageMin: 26,
    ageMax: 38,
    scope: 'COUNTRY',
    minEndorsements: 2,
    paused: false,
    createdAt: now,
    updatedAt: now,
  }

  it('shows another person the answers and nothing private', () => {
    const view = toPublicProfile(row)
    expect(Object.keys(view).sort()).toEqual(['ambition', 'ambitionLabel', 'direction', 'obsessions', 'promptBuild', 'promptObsessed', 'promptWeekend', 'rhythm'])
    expect(JSON.stringify(view)).not.toMatch(/gender|interested|ageM|scope|minEndorsements|WOMAN|MAN/)
    expect(view.ambitionLabel).toBe('Driven')
  })

  it('shows the owner their private filters under one key', () => {
    const view = toOwnProfile(row)
    expect(view.private).toEqual({ gender: 'WOMAN', genderSelfDescribe: null, interestedIn: ['MAN'], ageMin: 26, ageMax: 38, scope: 'COUNTRY', minEndorsements: 2 })
    expect(Object.keys(view)).toEqual(expect.arrayContaining(['private', 'paused', 'createdAt', 'updatedAt']))
  })

  it('falls back to safe values for a stored value it no longer knows', () => {
    const view = toPublicProfile({ ...row, direction: 'retired', rhythm: 'nocturnal' })
    expect(view.direction).toBe('open')
    expect(view.rhythm).toBe('steady')
  })

  it('writes the columns, dropping a self-description that does not apply', () => {
    const parsed = romanceProfileSchema.parse({ ...valid, gender: 'MAN', genderSelfDescribe: null })
    expect(profileColumns(parsed).genderSelfDescribe).toBeNull()
    const described = romanceProfileSchema.parse({ ...valid, gender: 'SELF_DESCRIBED', genderSelfDescribe: 'agender' })
    expect(profileColumns(described).genderSelfDescribe).toBe('agender')
  })
})

describe('scope needs a place', () => {
  it('asks for a city for CITY and a country for COUNTRY, and nothing for ANYWHERE', () => {
    expect(scopeProblems({ scope: 'CITY' }, { cityKey: null, countryCode: 'IN' })).toEqual({ scope: [expect.stringContaining('city')] })
    expect(scopeProblems({ scope: 'CITY' }, { cityKey: 'pune', countryCode: null })).toBeNull()
    expect(scopeProblems({ scope: 'COUNTRY' }, { cityKey: 'pune', countryCode: null })).toEqual({ scope: [expect.stringContaining('country')] })
    expect(scopeProblems({ scope: 'ANYWHERE' }, { cityKey: null, countryCode: null })).toBeNull()
  })
})

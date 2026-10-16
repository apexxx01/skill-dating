import { describe, it, expect } from 'vitest'
import { buildIcebreaker, sharedGround, type SharedGround } from './icebreaker'
import type { ScoringProfile } from './score'

const now = new Date('2026-10-16T12:00:00Z')

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
const skill = (slug: string, name: string, level: number) => ({ slug, name, level, evidence: 0 })
const none: SharedGround = { skills: [], stack: [], intents: [], sameHackathon: false }

describe('sharedGround', () => {
  it('finds the skills both have, by the lower level, strongest first', () => {
    const a = profile({ skills: [skill('react', 'React', 5), skill('ts', 'TypeScript', 3), skill('go', 'Go', 4)] })
    const b = profile({ skills: [skill('ts', 'TypeScript', 5), skill('react', 'React', 2), skill('rust', 'Rust', 5)] })
    expect(sharedGround(a, b, now).skills).toEqual(['TypeScript', 'React'])
    expect(sharedGround(b, a, now).skills).toEqual(['TypeScript', 'React'])
  })

  it('finds the technologies both build with, ignoring case and spaces', () => {
    expect(sharedGround(profile({ techStack: ['React', ' Postgres '] }), profile({ techStack: ['postgres', 'REACT', 'Go'] }), now).stack).toEqual(['Postgres', 'React'])
    expect(sharedGround(profile({ techStack: [''] }), profile({ techStack: [''] }), now).stack).toEqual([])
  })

  it('finds intents both have that are still live, and a hackathon only for the same one', () => {
    const a = profile({ intentTags: [{ tag: 'open-source' }, { tag: 'win-a-hackathon', hackathonId: 'h1' }, { tag: 'old-tag', expiresAt: '2026-10-01T00:00:00Z' }] })
    const b = profile({ intentTags: [{ tag: 'open-source' }, { tag: 'win-a-hackathon', hackathonId: 'h1' }, { tag: 'old-tag' }] })
    expect(sharedGround(a, b, now)).toMatchObject({ intents: ['open-source', 'win-a-hackathon'], sameHackathon: true })
    const other = profile({ intentTags: [{ tag: 'win-a-hackathon', hackathonId: 'h2' }] })
    expect(sharedGround(a, other, now)).toMatchObject({ intents: [], sameHackathon: false })
  })

  it('is empty for two people with nothing in common', () => {
    expect(sharedGround(profile(), profile(), now)).toEqual(none)
  })
})

describe('buildIcebreaker', () => {
  it('names what the two share, and ends with a first question for the type', () => {
    const text = buildIcebreaker('COFOUNDER', { skills: ['React', 'TypeScript'], stack: ['Postgres'], intents: ['ship-by-year-end'], sameHackathon: false })
    expect(text).toBe(
      'It is a match: you both want a cofounder. Both want to ship by year end. You both know React and TypeScript. You both build with Postgres. A good first question: what are you each building right now, and what would you want a cofounder to own?'
    )
  })

  it('still says something useful when there is nothing in common', () => {
    const text = buildIcebreaker('COLLABORATOR', none)
    expect(text).toContain('It is a match')
    expect(text).toContain('A good first question')
  })

  it('mentions at most three skills and three technologies', () => {
    const text = buildIcebreaker('COFOUNDER', { skills: ['A', 'B', 'C', 'D'], stack: ['w', 'x', 'y', 'z'], intents: [], sameHackathon: false })
    expect(text).toContain('You both know A, B and C.')
    expect(text).toContain('You both build with w, x and y.')
    expect(text).not.toContain('D.')
  })

  it('says the same hackathon once, not twice', () => {
    const text = buildIcebreaker('HACKATHON_TEAMMATE', { skills: [], stack: [], intents: ['win-a-hackathon'], sameHackathon: true })
    expect(text).toContain('You are both going for the same hackathon.')
    expect(text).not.toContain('win a hackathon')
  })

  it('is the same from either side of a mentoring match, with a question for the side asking', () => {
    expect(buildIcebreaker('MENTOR', none)).toContain('a mentor and a mentee')
    expect(buildIcebreaker('MENTOR', none)).toContain('help someone get unstuck')
    expect(buildIcebreaker('MENTEE', none)).toContain('what are you stuck on')
  })

  it('leaves skills and technologies out of a dating match, and uses nothing else about work history', () => {
    const text = buildIcebreaker('DATING', { skills: ['React'], stack: ['Postgres'], intents: ['open-source'], sameHackathon: false })
    expect(text).not.toMatch(/React|Postgres|know|build with/)
    expect(text).toContain('Both want to build in the open.')
    expect(text.startsWith('It is a match.')).toBe(true)
  })

  it('never guesses a pronoun and stays short', () => {
    for (const type of ['COFOUNDER', 'HACKATHON_TEAMMATE', 'COLLABORATOR', 'MENTOR', 'MENTEE', 'DATING'] as const) {
      const text = buildIcebreaker(type, { skills: ['React', 'Go', 'Rust'], stack: ['a', 'b', 'c'], intents: ['open-source'], sameHackathon: true })
      expect(text).not.toMatch(/\b(she|he|her|his|him)\b/i)
      expect(text.length).toBeLessThanOrEqual(500)
    }
  })
})

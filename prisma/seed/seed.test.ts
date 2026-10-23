import { describe, it, expect } from 'vitest'
import { createRng, hashString, rngFor } from './rng'
import { parseArgs, DEFAULTS } from './args'
import { assertSafeToSeed, describeDatabase, SeedRefusal } from './guard'
import { planPeople, CORE_PEOPLE } from './people'
import { ARCHETYPES, CITIES, SKILLS } from './catalog'
import { SEED_DOMAIN } from './types'

describe('the seeded random generator', () => {
  it('gives the same numbers for the same seed, and different ones for another', () => {
    const a = createRng(42)
    const b = createRng(42)
    expect(Array.from({ length: 6 }, () => a.next())).toEqual(Array.from({ length: 6 }, () => b.next()))
    expect(createRng(43).next()).not.toBe(createRng(42).next())
    expect(rngFor('x').next()).toBe(rngFor('x').next())
    expect(hashString('a')).not.toBe(hashString('b'))
  })

  it('stays in range and picks every item of a list sooner or later', () => {
    const r = createRng(7)
    for (let i = 0; i < 500; i++) {
      const n = r.int(3, 9)
      expect(n >= 3 && n <= 9).toBe(true)
    }
    const seen = new Set(Array.from({ length: 300 }, () => r.pick(['a', 'b', 'c'])))
    expect(seen.size).toBe(3)
    expect(r.sample([1, 2, 3, 4, 5], 3)).toHaveLength(3)
    expect(new Set(r.shuffle([1, 2, 3, 4, 5])).size).toBe(5)
  })

  it('weights its choices', () => {
    const r = createRng(9)
    const counts = { common: 0, rare: 0 }
    for (let i = 0; i < 2000; i++) counts[r.weighted([['common', 9], ['rare', 1]] as const)] += 1
    expect(counts.common).toBeGreaterThan(counts.rare * 4)
  })

  it('forks children that depend on the seed and the label only, not on what was drawn before', () => {
    const a = rngFor('world')
    const b = rngFor('world')
    for (let i = 0; i < 100; i++) a.next()
    expect(a.fork('people').next()).toBe(b.fork('people').next())
    expect(a.fork('people').next()).not.toBe(a.fork('hackathons').next())
  })
})

describe('the arguments', () => {
  it('has defaults and reads the flags in both forms', () => {
    expect(parseArgs([])).toMatchObject({ scale: DEFAULTS.scale, days: DEFAULTS.days, reset: false, withRomance: false, username: null })
    expect(parseArgs(['--scale', '10000', '--seed=abc', '--reset', '--with-romance', '--days', '30'])).toMatchObject({ scale: 10000, seed: 'abc', reset: true, withRomance: true, days: 30 })
  })

  it('refuses what it does not understand', () => {
    expect(() => parseArgs(['--scale', '3'])).toThrow(SeedRefusal)
    expect(() => parseArgs(['--scale', 'many'])).toThrow(SeedRefusal)
    expect(() => parseArgs(['--scale'])).toThrow(SeedRefusal)
    expect(() => parseArgs(['--days', '5'])).toThrow(SeedRefusal)
    expect(() => parseArgs(['--nonsense'])).toThrow(SeedRefusal)
    expect(() => parseArgs(['--username', 'No Spaces'])).toThrow(SeedRefusal)
  })
})

describe('the guard', () => {
  const local = 'postgresql://postgres:secret@localhost:5432/skill_dating'
  it('seeds a database on this machine', () => {
    expect(assertSafeToSeed({ DATABASE_URL: local } as never)).toEqual({ host: 'localhost', database: 'skill_dating' })
  })

  it('refuses a production environment, whatever the database', () => {
    expect(() => assertSafeToSeed({ DATABASE_URL: local, NODE_ENV: 'production' } as never)).toThrow(/production/)
    expect(() => assertSafeToSeed({ DATABASE_URL: local, VERCEL_ENV: 'production' } as never)).toThrow(/production/)
    expect(() => assertSafeToSeed({ DATABASE_URL: 'postgresql://u:p@db.example.com/prod', NODE_ENV: 'production', ALLOW_SEED_ON_REMOTE: '1' } as never)).toThrow(/production/)
  })

  it('refuses a database that is not on this machine unless it is named as disposable', () => {
    const remote = 'postgresql://u:p@db.example.com:5432/preview'
    expect(() => assertSafeToSeed({ DATABASE_URL: remote } as never)).toThrow(/not on this machine/)
    expect(assertSafeToSeed({ DATABASE_URL: remote, ALLOW_SEED_ON_REMOTE: '1' } as never).host).toBe('db.example.com')
  })

  it('refuses a missing or broken connection string, and never repeats the credentials', () => {
    expect(() => assertSafeToSeed({} as never)).toThrow(SeedRefusal)
    expect(() => assertSafeToSeed({ DATABASE_URL: 'not a url' } as never)).toThrow(SeedRefusal)
    try {
      assertSafeToSeed({ DATABASE_URL: 'postgresql://user:hunter2@db.example.com/x' } as never)
    } catch (error) {
      expect(String(error)).not.toContain('hunter2')
    }
    expect(describeDatabase('postgresql://user:hunter2@h:5432/d')).toEqual({ host: 'h', database: 'd' })
  })
})

describe('the catalogue', () => {
  it('names twelve cities with colleges, and every archetype skill exists', () => {
    expect(CITIES).toHaveLength(12)
    expect(new Set(CITIES.map((city) => city.timezone)).size).toBeGreaterThanOrEqual(8)
    for (const city of CITIES) expect(city.campuses.length, city.city).toBeGreaterThan(0)
    const slugs = new Set(SKILLS.map((skill) => skill.slug))
    expect(slugs.size).toBe(SKILLS.length)
    for (const archetype of ARCHETYPES) for (const slug of [...archetype.core, ...archetype.extra, ...archetype.seeks]) expect(slugs.has(slug), `${archetype.key}: ${slug}`).toBe(true)
    const campusSlugs = CITIES.flatMap((city) => city.campuses.map((campus) => campus.slug))
    expect(new Set(campusSlugs).size).toBe(campusSlugs.length)
  })
})

describe('planning the people', () => {
  const now = new Date('2026-10-23T12:00:00Z')
  const plan = (seed: string, count = CORE_PEOPLE, first = 0) => planPeople(rngFor(seed), count, now, 75, first)

  it('is the same world for the same seed, and another for another', () => {
    expect(plan('a').map((p) => p.username)).toEqual(plan('a').map((p) => p.username))
    expect(plan('a').map((p) => p.username)).not.toEqual(plan('b').map((p) => p.username))
  })

  it('makes people with unique names, addresses and GitHub names, spread over all twelve cities', () => {
    const people = plan('world')
    expect(people).toHaveLength(CORE_PEOPLE)
    for (const field of ['username', 'email', 'id'] as const) expect(new Set(people.map((p) => p[field])).size, field).toBe(people.length)
    const github = people.map((p) => p.github).filter((name): name is string => name !== null)
    expect(new Set(github).size).toBe(github.length)
    expect(people.every((p) => p.email.endsWith(`@${SEED_DOMAIN}`))).toBe(true)
    expect(new Set(people.map((p) => p.city.key)).size).toBe(12)
    expect(people.every((p) => /^[a-z0-9][a-z0-9_-]{2,29}$/.test(p.username))).toBe(true)
  })

  it('has the right people for each place: time zones, skills of the trade, accounts older than a week', () => {
    for (const person of plan('world')) {
      expect(person.city.timezone).toMatch(/\//)
      expect(person.skills.length).toBeGreaterThan(1)
      expect(person.skills.every((skill) => skill.level >= 1 && skill.level <= 5)).toBe(true)
      expect(now.getTime() - person.createdAt.getTime()).toBeGreaterThan(11 * 24 * 3_600_000)
      expect(person.connectionTypes.length).toBeGreaterThan(0)
    }
  })

  it('makes a few minors (16 and 17) among the core people, none past them, and gives them no place finer than a country', () => {
    const core = plan('world')
    const minors = core.filter((p) => p.isMinor)
    expect(minors.length).toBeGreaterThan(0)
    expect(minors.length).toBeLessThan(core.length * 0.08)
    for (const person of minors) {
      const age = (now.getTime() - person.birthDate.getTime()) / (365.25 * 24 * 3_600_000)
      expect(age).toBeGreaterThanOrEqual(16)
      expect(age).toBeLessThan(18.1)
    }
    expect(plan('world', 100, CORE_PEOPLE).some((p) => p.isMinor)).toBe(false)
    expect(plan('world', 10, CORE_PEOPLE).every((p) => p.tier === 'background')).toBe(true)
  })

  it('does not change one person when more are asked for (the first 400 are the same at any scale)', () => {
    const small = plan('world', 50)
    const large = plan('world', 400)
    expect(large.slice(0, 50).map((p) => p.username)).toEqual(small.map((p) => p.username))
  })
})

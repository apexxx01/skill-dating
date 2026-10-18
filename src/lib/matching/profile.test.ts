import { describe, it, expect, vi } from 'vitest'
import {
  checkDatingGate,
  DEFAULT_MATCHING_PROFILE,
  datingRefusal,
  datingStatus,
  matchingProfileSchema,
  profileData,
  readIntentTags,
  referenceProblems,
  toView,
  type StoredMatchingProfile,
} from './profile'

const parse = (value: unknown) => matchingProfileSchema.safeParse(value)
const now = new Date('2026-10-16T12:00:00Z')

describe('matchingProfileSchema', () => {
  it('needs only the types, and gives everything else its default', () => {
    const result = parse({ connectionTypes: ['COFOUNDER'] })
    expect(result.success).toBe(true)
    expect(result.success && result.data).toEqual({
      connectionTypes: ['COFOUNDER'],
      intentTags: [],
      hoursPerWeek: null,
      availableFrom: null,
      remoteOk: true,
      cityOnly: false,
      lookingForSkills: [],
      workingStyle: {},
      dropTimeLocal: '09:00',
      paused: false,
    })
  })

  it('accepts a full profile', () => {
    expect(
      parse({
        connectionTypes: ['COFOUNDER', 'MENTEE'],
        intentTags: [{ tag: 'ship-mvp-90-days' }, { tag: 'win-a-hackathon', hackathonId: 'h1', expiresAt: '2026-12-01T00:00:00Z' }],
        hoursPerWeek: 15,
        availableFrom: '2026-11-01',
        remoteOk: false,
        cityOnly: true,
        lookingForSkills: ['ml', 'react'],
        workingStyle: { pace: 'steady', rhythm: 'night' },
        dropTimeLocal: '07:30',
        paused: true,
      }).success
    ).toBe(true)
  })

  it('needs at least one connection type, each once, from the known ones', () => {
    for (const bad of [[], ['FRIEND'], ['COFOUNDER', 'COFOUNDER'], 'COFOUNDER', [1]]) expect(parse({ connectionTypes: bad }).success, JSON.stringify(bad)).toBe(false)
    expect(parse({}).success).toBe(false)
  })

  it('refuses unknown fields: nothing else can be set through here', () => {
    expect(parse({ connectionTypes: ['COFOUNDER'], lastDropDate: '2026-10-16' }).success).toBe(false)
    expect(parse({ connectionTypes: ['COFOUNDER'], userId: 'x' }).success).toBe(false)
  })

  it('checks the hours, the date, the drop time and the quiz answers', () => {
    const base = { connectionTypes: ['COFOUNDER'] }
    for (const bad of [{ hoursPerWeek: 0 }, { hoursPerWeek: 101 }, { hoursPerWeek: 2.5 }, { hoursPerWeek: '10' }, { availableFrom: '2026-02-30' }, { availableFrom: 'soon' }, { dropTimeLocal: '24:00' }, { dropTimeLocal: '9:00' }, { dropTimeLocal: '09:60' }, { workingStyle: { pace: 'nope' } }, { workingStyle: { weather: 'sunny' } }, { remoteOk: 'yes' }, { paused: 1 }]) {
      expect(parse({ ...base, ...bad }).success, JSON.stringify(bad)).toBe(false)
    }
    for (const ok of [{ hoursPerWeek: 1 }, { hoursPerWeek: 100 }, { availableFrom: '2026-02-28' }, { dropTimeLocal: '00:00' }, { dropTimeLocal: '23:59' }, { hoursPerWeek: null }, { availableFrom: null }]) {
      expect(parse({ ...base, ...ok }).success, JSON.stringify(ok)).toBe(true)
    }
  })

  it('checks intent tags: well-formed, at most ten, each once, known keys only', () => {
    const base = { connectionTypes: ['COFOUNDER'] }
    expect(parse({ ...base, intentTags: [{ tag: 'Bad Tag' }] }).success).toBe(false)
    expect(parse({ ...base, intentTags: [{ tag: 'x' }] }).success).toBe(false)
    expect(parse({ ...base, intentTags: [{ tag: 'ok-tag', color: 'red' }] }).success).toBe(false)
    expect(parse({ ...base, intentTags: [{ tag: 'ok-tag', expiresAt: 'tomorrow' }] }).success).toBe(false)
    expect(parse({ ...base, intentTags: [{ tag: 'ok-tag' }, { tag: 'ok-tag' }] }).success).toBe(false)
    expect(parse({ ...base, intentTags: [{ tag: 'ok-tag' }, { tag: 'ok-tag', hackathonId: 'h1' }] }).success).toBe(true)
    expect(parse({ ...base, intentTags: Array.from({ length: 11 }, (_, i) => ({ tag: `tag-${i}` })) }).success).toBe(false)
    expect(parse({ ...base, intentTags: Array.from({ length: 10 }, (_, i) => ({ tag: `tag-${i}` })) }).success).toBe(true)
  })

  it('checks looking-for skills: slugs, each once, at most twenty', () => {
    const base = { connectionTypes: ['COFOUNDER'] }
    expect(parse({ ...base, lookingForSkills: ['Machine Learning'] }).success).toBe(false)
    expect(parse({ ...base, lookingForSkills: ['ml', 'ml'] }).success).toBe(false)
    expect(parse({ ...base, lookingForSkills: Array.from({ length: 21 }, (_, i) => `s${i}`) }).success).toBe(false)
  })
})

describe('profileData and toView', () => {
  it('stores the date as a date and normalises the expiry, and shows it back the way it came', () => {
    const input = matchingProfileSchema.parse({
      connectionTypes: ['COFOUNDER'],
      availableFrom: '2026-11-01',
      intentTags: [{ tag: 'open-source', expiresAt: '2026-12-01T05:30:00+05:30' }],
      workingStyle: { pace: 'steady' },
    })
    const data = profileData(input)
    expect(data.availableFrom).toEqual(new Date('2026-11-01T00:00:00Z'))
    expect(data.intentTags).toEqual([{ tag: 'open-source', expiresAt: '2026-12-01T00:00:00.000Z' }])
    const view = toView({ ...(data as unknown as StoredMatchingProfile) })
    expect(view).toMatchObject({ availableFrom: '2026-11-01', connectionTypes: ['COFOUNDER'], workingStyle: { pace: 'steady' } })
  })

  it('has defaults for a person with no profile, and none of them is a type', () => {
    expect(toView(null)).toEqual(DEFAULT_MATCHING_PROFILE)
    expect(toView(null).connectionTypes).toEqual([])
    expect(toView(null)).not.toBe(DEFAULT_MATCHING_PROFILE)
  })

  it('reads whatever was stored, dropping what is no longer valid', () => {
    expect(readIntentTags([{ tag: 'good-tag' }, { tag: 'BAD' }, 'x', null, { tag: 'with-hack', hackathonId: 'h', expiresAt: '2026-12-01T00:00:00.000Z', extra: 1 }])).toEqual([
      { tag: 'good-tag' },
      { tag: 'with-hack', hackathonId: 'h', expiresAt: '2026-12-01T00:00:00.000Z' },
    ])
    expect(readIntentTags('nope')).toEqual([])
    expect(readIntentTags(null)).toEqual([])
  })
})

describe('referenceProblems', () => {
  const db = (skills: string[], hackathons: string[]) =>
    ({
      skill: { findMany: vi.fn(async ({ where }: { where: { slug: { in: string[] } } }) => where.slug.in.filter((slug) => skills.includes(slug)).map((slug) => ({ slug }))) },
      hackathon: { findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.filter((id) => hackathons.includes(id)).map((id) => ({ id }))) },
    }) as never
  const input = (over: object) => matchingProfileSchema.parse({ connectionTypes: ['COFOUNDER'], ...over })

  it('is null when everything exists and nothing has expired', async () => {
    expect(await referenceProblems(db(['ml'], ['h1']), input({ lookingForSkills: ['ml'], intentTags: [{ tag: 'win-a-hackathon', hackathonId: 'h1', expiresAt: '2026-12-01T00:00:00Z' }] }), now)).toBeNull()
  })

  it('does not touch the database for a profile that names nothing', async () => {
    const client = db([], [])
    expect(await referenceProblems(client, input({}), now)).toBeNull()
    expect((client as unknown as { skill: { findMany: ReturnType<typeof vi.fn> } }).skill.findMany).not.toHaveBeenCalled()
    expect((client as unknown as { hackathon: { findMany: ReturnType<typeof vi.fn> } }).hackathon.findMany).not.toHaveBeenCalled()
  })

  it('names the skills and hackathons that do not exist', async () => {
    const problems = await referenceProblems(db(['ml'], []), input({ lookingForSkills: ['ml', 'quantum-baking'], intentTags: [{ tag: 'win-a-hackathon', hackathonId: 'nope' }] }), now)
    expect(problems).toEqual({ lookingForSkills: ['Unknown skill: quantum-baking'], intentTags: ['Unknown hackathon: nope'] })
  })

  it('refuses a tag that has expired or expires in more than a year', async () => {
    const problems = await referenceProblems(db([], []), input({ intentTags: [{ tag: 'past-tag', expiresAt: '2026-10-01T00:00:00Z' }, { tag: 'far-tag', expiresAt: '2028-01-01T00:00:00Z' }, { tag: 'fine-tag', expiresAt: '2027-01-01T00:00:00Z' }] }), now)
    expect(problems).toEqual({ intentTags: ['past-tag has already expired', 'far-tag expires more than a year from now'] })
  })
})

describe('the dating gate', () => {
  const facts = { birthDate: new Date('1995-06-15T00:00:00Z'), isEmailVerified: true, isPhoneVerified: true, githubConnected: false }

  it('tells a missing date of birth first, then age, then verification', () => {
    expect(datingRefusal(['BIRTH_DATE_MISSING', 'EMAIL_NOT_VERIFIED'])).toBe('DATING_BIRTH_DATE_REQUIRED')
    expect(datingRefusal(['UNDER_AGE', 'EMAIL_NOT_VERIFIED'])).toBe('DATING_UNDERAGE')
    expect(datingRefusal(['EMAIL_NOT_VERIFIED'])).toBe('DATING_VERIFICATION_REQUIRED')
    expect(datingRefusal(['NO_PHONE_OR_GITHUB'])).toBe('DATING_VERIFICATION_REQUIRED')
    expect(datingRefusal([])).toBeNull()
  })

  it('reports whether the gate is open and what is missing', () => {
    expect(datingStatus(facts, now)).toEqual({ eligible: true, blockers: [], minAge: 18 })
    expect(datingStatus({ ...facts, birthDate: null }, now)).toEqual({ eligible: false, blockers: ['BIRTH_DATE_MISSING'], minAge: 18 })
    expect(datingStatus(null, now).eligible).toBe(false)
  })

  it('loads the person and applies it', async () => {
    const db = (row: unknown) => ({ user: { findUnique: vi.fn(async () => row) } }) as never
    expect(await checkDatingGate(db(facts), 'u1', now)).toBeNull()
    expect(await checkDatingGate(db({ ...facts, birthDate: new Date('2010-01-01T00:00:00Z') }), 'u1', now)).toEqual({ code: 'DATING_UNDERAGE', blockers: ['UNDER_AGE'] })
    expect(await checkDatingGate(db({ ...facts, birthDate: null }), 'u1', now)).toEqual({ code: 'DATING_BIRTH_DATE_REQUIRED', blockers: ['BIRTH_DATE_MISSING'] })
    expect(await checkDatingGate(db(null), 'u1', now)).toMatchObject({ code: 'DATING_BIRTH_DATE_REQUIRED' })
  })
})

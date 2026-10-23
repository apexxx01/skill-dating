import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, promoteToAdmin, testPrisma } from './db'
import { INTEGRATION_DATABASE_URL } from './config'
import { bornYearsAgo, makePerson, removePeople } from './matching-fixtures'
import { makeRomancePerson } from './romance-fixtures'
import { demandMetrics, PLACE_MINIMUM } from '../../src/lib/kpi/compute-ops'
import { ROMANCE_MODE_LABEL } from '../../src/lib/romance/config'

// The romance mode ships CLOSED: every route answers ROMANCE_PAUSED, it is in no list a person reads, and the one thing that works is asking to be told when it opens. It opens with the
// flag `romance.enabled` (or a city's flag `romance.city.in-pune`), and the people who asked are told once. The suite's global setup opens the mode for the other files; this one closes it
// for its own run and puts it back.
describe('the romance launch gate', () => {
  const suffix = uniqueSuffix()
  const tag = `rl${suffix}`
  let admin: TestUser
  let ada: TestUser // an adult in Pune
  let bob: TestUser // an adult in Bengaluru
  let kid: TestUser // 17
  let unknownAge: TestUser // no date of birth
  const cityFlag = 'romance.city.in-pune'

  const flip = (key: string, enabled: boolean) => req(admin.jar, 'PATCH', `/api/admin/flags/${key}`, { enabled })
  const place = (userId: string, countryCode: string, city: string, cityKey: string) =>
    testPrisma.profile.upsert({ where: { userId }, create: { userId, countryCode, city, cityKey }, update: { countryCode, city, cityKey } })

  beforeAll(async () => {
    process.env.DATABASE_URL = INTEGRATION_DATABASE_URL
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??= 'pk_test_integration'
    process.env.CLERK_SECRET_KEY ??= 'sk_test_integration'
    admin = await registerAndLogin(`rla${suffix}@test.dev`, `rla${suffix}`)
    await promoteToAdmin(admin.userId)
    ada = await registerAndLogin(`rlb${suffix}@test.dev`, `rlb${suffix}`)
    bob = await registerAndLogin(`rlc${suffix}@test.dev`, `rlc${suffix}`)
    kid = await registerAndLogin(`rld${suffix}@test.dev`, `rld${suffix}`)
    unknownAge = await registerAndLogin(`rle${suffix}@test.dev`, `rle${suffix}`)
    for (const [user, born] of [[ada, bornYearsAgo(30, 40)], [bob, bornYearsAgo(28, 40)], [kid, bornYearsAgo(17, 40)]] as const) {
      await testPrisma.user.update({ where: { id: user.userId }, data: { birthDate: new Date(`${born}T00:00:00Z`) } })
    }
    await place(ada.userId, 'IN', 'Pune', 'pune')
    await place(bob.userId, 'IN', 'Bengaluru', 'bengaluru')
    expect((await flip('romance.enabled', false)).status).toBe(200)
  }, 180_000)

  afterAll(async () => {
    await flip('romance.enabled', true)
    await flip('kill.romance', false)
    await testPrisma.featureFlag.deleteMany({ where: { key: cityFlag } })
    await testPrisma.notification.deleteMany({ where: { coalesceKey: 'romance:open', userId: { in: [ada.userId, bob.userId] } } })
    await removePeople(tag)
    await cleanupTestUsers(suffix)
  }, 120_000)

  describe('while it is closed', () => {
    it('is closed by default: the flag is created off by the migration', async () => {
      const row = await testPrisma.featureFlag.findUnique({ where: { key: 'romance.enabled' } })
      expect(row).toMatchObject({ enabled: false, rolloutPercent: 100 })
    })

    it('answers ROMANCE_PAUSED on every romance route, with the mode’s name in the message', async () => {
      const calls: [string, string, unknown?][] = [
        ['GET', '/api/romance/profile'],
        ['PUT', '/api/romance/profile', {}],
        ['GET', '/api/romance/drop'],
        ['POST', '/api/romance/drop/anything/pass', {}],
        ['POST', '/api/romance/sparks', { userId: bob.userId, opener: 'x' }],
        ['GET', '/api/romance/sparks/received'],
        ['GET', '/api/romance/matches'],
        ['GET', '/api/romance/matches/anything'],
        ['POST', '/api/romance/matches/anything/reveal', {}],
        ['GET', '/api/romance/duo'],
        ['DELETE', '/api/romance/photos/anything'],
        ['POST', '/api/romance/photos', {}],
      ]
      for (const [method, path, body] of calls) {
        const res = await req(ada.jar, method, path, body)
        expect(res.status, `${method} ${path}`).toBe(503)
        expect(res.data.error.code, `${method} ${path}`).toBe('ROMANCE_PAUSED')
      }
      expect((await req(ada.jar, 'GET', '/api/romance/profile')).data.error.message).toContain(ROMANCE_MODE_LABEL)
    })

    it('still lets a person leave it, which must always work', async () => {
      expect((await req(ada.jar, 'DELETE', '/api/romance/profile')).status).toBe(200)
    })

    it('is in no list a person reads: consents, notification settings, flags', async () => {
      const consents = await req(ada.jar, 'GET', '/api/users/me/consents')
      expect(consents.status).toBe(200)
      expect(consents.data.consents.map((c: { type: string }) => c.type).sort()).toEqual(['MARKETING', 'PRIVACY', 'TERMS'])
      expect((await req(ada.jar, 'POST', '/api/users/me/consents', { type: 'ROMANCE_MODE', version: '2026-10-01', source: 'romance-optin' })).data.error.code).toBe('ROMANCE_PAUSED')

      const preferences = await req(ada.jar, 'GET', '/api/notifications/preferences')
      expect(preferences.data.preferences.map((p: { kind: string }) => p.kind).filter((kind: string) => kind.startsWith('ROMANCE_'))).toEqual([])
      const channels = await req(ada.jar, 'GET', '/api/notifications/channels')
      expect(channels.data.kinds.map((k: { kind: string }) => k.kind).filter((kind: string) => kind.startsWith('ROMANCE_'))).toEqual([])

      const flags = await req(ada.jar, 'GET', '/api/flags')
      expect(Object.keys(flags.data.flags).filter((key) => key.includes('romance'))).toEqual([])
      // Nothing in the answers says the mode's name.
      for (const body of [consents.data, preferences.data, channels.data, flags.data]) expect(JSON.stringify(body)).not.toContain(ROMANCE_MODE_LABEL)
    })

    it('does not draw a weekly drop for anybody: the jobs skip the people it is closed for', async () => {
      const { runRomanceBatchJob, runRomanceDropsJob } = await import('../../src/lib/romance/drops')
      // The jobs run in this process and read the launch flags through its flag cache, so ask it to look again.
      const { invalidateFlags } = await import('../../src/lib/flags')
      await invalidateFlags()
      const [viewer, candidate] = await Promise.all([makeRomancePerson({ tag, gender: 'WOMAN', interestedIn: ['MAN'] }), makeRomancePerson({ tag, gender: 'MAN', interestedIn: ['WOMAN'] })])
      expect(await runRomanceBatchJob({ userIds: [viewer.id, candidate.id] })).toMatchObject({ due: 0, generated: 0, drops: 0 })
      expect(await runRomanceDropsJob({ userIds: [viewer.id, candidate.id] })).toMatchObject({ due: 0, generated: 0, drops: 0 })
      expect(await testPrisma.romanceDrop.count({ where: { userId: { in: [viewer.id, candidate.id] } } })).toBe(0)
    })
  })

  describe('asking to be told when it opens', () => {
    it('records an adult with the country and city on their profile, once, and withdraws', async () => {
      expect((await req(ada.jar, 'GET', '/api/romance/interest')).data).toEqual({ interested: false, open: false, eligible: true })
      const first = await req(ada.jar, 'POST', '/api/romance/interest')
      expect(first.status).toBe(200)
      expect(first.data).toEqual({ interested: true, open: false, eligible: true })
      const again = await req(ada.jar, 'POST', '/api/romance/interest')
      expect(again.status).toBe(200)
      expect(await testPrisma.romanceInterest.count({ where: { userId: ada.userId } })).toBe(1)
      expect(await testPrisma.romanceInterest.findUniqueOrThrow({ where: { userId: ada.userId } })).toMatchObject({ countryCode: 'IN', cityKey: 'pune', city: 'Pune', notifiedAt: null })

      // Moving updates what it is counted under when they ask again.
      await place(ada.userId, 'IN', 'Mumbai', 'mumbai')
      await req(ada.jar, 'POST', '/api/romance/interest')
      expect(await testPrisma.romanceInterest.findUniqueOrThrow({ where: { userId: ada.userId } })).toMatchObject({ cityKey: 'mumbai' })
      await place(ada.userId, 'IN', 'Pune', 'pune')
      await req(ada.jar, 'POST', '/api/romance/interest')

      const gone = await req(ada.jar, 'DELETE', '/api/romance/interest')
      expect(gone.data).toEqual({ interested: false, open: false, eligible: true })
      expect((await req(ada.jar, 'DELETE', '/api/romance/interest')).status).toBe(200)
      expect(await testPrisma.romanceInterest.count({ where: { userId: ada.userId } })).toBe(0)
    })

    it('is for adults with a date of birth on file: a minor and an unknown age are refused, the same way the mode refuses them', async () => {
      const minor = await req(kid.jar, 'POST', '/api/romance/interest')
      expect(minor.status).toBe(403)
      expect(minor.data.error.code).toBe('DATING_UNDERAGE')
      const unknown = await req(unknownAge.jar, 'POST', '/api/romance/interest')
      expect(unknown.status).toBe(403)
      expect(unknown.data.error.code).toBe('DATING_BIRTH_DATE_REQUIRED')
      expect(await testPrisma.romanceInterest.count({ where: { userId: { in: [kid.userId, unknownAge.userId] } } })).toBe(0)
      expect((await req(kid.jar, 'GET', '/api/romance/interest')).data).toEqual({ interested: false, open: false, eligible: false })
    })

    it('requires a signed-in person', async () => {
      const { cookieJar } = await import('./helpers')
      for (const method of ['GET', 'POST', 'DELETE']) expect((await req(cookieJar(), method, '/api/romance/interest')).status, method).toBe(401)
    })

    it('is removed with the account, with the rest of the data inventory', async () => {
      const person = await makePerson({ tag, profile: false, birthDate: bornYearsAgo(30, 100) })
      await testPrisma.romanceInterest.create({ data: { userId: person.id, countryCode: 'IN', cityKey: 'pune', city: 'Pune' } })
      await testPrisma.user.delete({ where: { id: person.id } })
      expect(await testPrisma.romanceInterest.count({ where: { userId: person.id } })).toBe(0)
    })
  })

  describe('the numbers the admin sees', () => {
    it('counts the people waiting by city and as a share of the adults active there, and hides a small city', async () => {
      const people: string[] = []
      const day = new Date().toISOString().slice(0, 10)
      const make = async (countryCode: string, cityKey: string, active: boolean, interested: boolean) => {
        const person = await makePerson({ tag, profile: false, birthDate: bornYearsAgo(30, 100) })
        people.push(person.id)
        await testPrisma.profile.upsert({ where: { userId: person.id }, create: { userId: person.id, countryCode, cityKey, city: cityKey }, update: { countryCode, cityKey, city: cityKey } })
        if (active) await testPrisma.activityDay.create({ data: { userId: person.id, day: new Date(`${day}T00:00:00Z`) } })
        if (interested) await testPrisma.romanceInterest.create({ data: { userId: person.id, countryCode, cityKey, city: cityKey } })
        return person
      }
      // Pune: 3 asked, 6 adults active (4 of whom did not ask). Lagos: 2 asked, below the minimum for a city. A minor who is active counts nowhere.
      await make('IN', 'pune-x', true, true)
      await make('IN', 'pune-x', true, true)
      await make('IN', 'pune-x', false, true)
      for (let i = 0; i < 4; i++) await make('IN', 'pune-x', true, false)
      await make('NG', 'lagos-x', true, true)
      await make('NG', 'lagos-x', true, true)
      const minor = await makePerson({ tag, profile: false, birthDate: bornYearsAgo(17, 40) })
      people.push(minor.id)
      await testPrisma.profile.create({ data: { userId: minor.id, countryCode: 'IN', cityKey: 'pune-x', city: 'pune-x' } })
      await testPrisma.activityDay.create({ data: { userId: minor.id, day: new Date(`${day}T00:00:00Z`) } })

      const rows = await demandMetrics(testPrisma, day, { userIds: people })
      const get = (key: string, dimension = '') => rows.find((row) => row.key === key && row.dimension === dimension)
      expect(PLACE_MINIMUM).toBe(3)
      expect(get('romance_interest')?.value).toBe(5)
      expect(get('romance_interest', 'city:IN:pune-x')?.value).toBe(3)
      expect(get('romance_interest', 'city:NG:lagos-x')).toBeUndefined()
      // 3 asked; the adults active in 30 days in Pune: 2 who asked + 4 who did not = 6.
      expect(get('romance_interest_share_of_adult_actives', 'city:IN:pune-x')).toMatchObject({ value: 3 / 6, detail: { interested: 3, adultActives: 6 } })
      // Everywhere: 5 asked; 8 adults active (6 in Pune, 2 in Lagos; the minor is not one of them).
      expect(get('romance_interest_share_of_adult_actives')).toMatchObject({ value: 5 / 8, detail: { interested: 5, adultActives: 8 } })
    })
  })

  describe('opening it', () => {
    it('opens city by city with the flag of the city, and the people waiting there are told once', async () => {
      await req(ada.jar, 'POST', '/api/romance/interest')
      await req(bob.jar, 'POST', '/api/romance/interest')
      const created = await req(admin.jar, 'POST', '/api/admin/flags', { key: cityFlag, description: 'Halves in Pune', enabled: true })
      expect(created.status).toBe(201)

      // Pune is open; Bengaluru is not.
      expect((await req(ada.jar, 'GET', '/api/romance/profile')).status).toBe(200)
      expect((await req(bob.jar, 'GET', '/api/romance/profile')).data.error.code).toBe('ROMANCE_PAUSED')
      expect((await req(ada.jar, 'GET', '/api/romance/interest')).data).toMatchObject({ interested: true, open: true })
      // Nothing to wait for any more.
      expect((await req(ada.jar, 'POST', '/api/romance/interest')).data.error.code).toBe('ROMANCE_ALREADY_OPEN')
      // The consent and the notification kinds appear for the person it is open for, not for the other.
      expect((await req(ada.jar, 'GET', '/api/users/me/consents')).data.consents.map((c: { type: string }) => c.type)).toContain('ROMANCE_MODE')
      expect((await req(bob.jar, 'GET', '/api/users/me/consents')).data.consents.map((c: { type: string }) => c.type)).not.toContain('ROMANCE_MODE')
      expect((await req(ada.jar, 'GET', '/api/notifications/preferences')).data.preferences.map((p: { kind: string }) => p.kind)).toContain('ROMANCE_DROP')

      // The note is written once, to the person it opened for.
      for (let i = 0; i < 3; i++) expect((await req(admin.jar, 'POST', '/api/admin/jobs/romance/announce', {})).status).toBe(200)
      const notes = await testPrisma.notification.findMany({ where: { coalesceKey: 'romance:open', userId: { in: [ada.userId, bob.userId] } } })
      expect(notes.map((n) => n.userId)).toEqual([ada.userId])
      expect(notes[0]).toMatchObject({ type: 'SYSTEM', link: '/romance', title: `${ROMANCE_MODE_LABEL} is open for you`, metadata: { kind: 'ROMANCE_OPEN' } })
      expect((await testPrisma.romanceInterest.findUniqueOrThrow({ where: { userId: ada.userId } })).notifiedAt).not.toBeNull()
      expect((await testPrisma.romanceInterest.findUniqueOrThrow({ where: { userId: bob.userId } })).notifiedAt).toBeNull()
    })

    it('opens everywhere with the flag, and the kill switch closes it again at once', async () => {
      expect((await flip('romance.enabled', true)).status).toBe(200)
      expect((await req(bob.jar, 'GET', '/api/romance/profile')).status).toBe(200)
      for (let i = 0; i < 2; i++) await req(admin.jar, 'POST', '/api/admin/jobs/romance/announce', {})
      expect(await testPrisma.notification.count({ where: { coalesceKey: 'romance:open', userId: bob.userId } })).toBe(1)

      expect((await flip('kill.romance', true)).status).toBe(200)
      expect((await req(bob.jar, 'GET', '/api/romance/profile')).data.error.code).toBe('ROMANCE_PAUSED')
      expect((await req(ada.jar, 'GET', '/api/romance/profile')).data.error.code).toBe('ROMANCE_PAUSED')
      expect((await flip('kill.romance', false)).status).toBe(200)
      expect((await req(bob.jar, 'GET', '/api/romance/profile')).status).toBe(200)
    })
  })
})

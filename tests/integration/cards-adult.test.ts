import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { INTEGRATION_DATABASE_URL } from './config'
import { cleanupTestUsers, testPrisma } from './db'
import { uniqueSuffix } from './helpers'
import { bornYearsAgo, makePerson, removePeople } from './matching-fixtures'
import { parseBirthDate } from '../../src/lib/age'
import { setBirthDate, cardsAvailable } from '../../src/lib/birth-date'
import { correctBirthDate } from '../../src/lib/birth-date-admin'
import { deliveryKindOf } from '../../src/lib/notify/policy'
import { CARDS_ADULT_KEY, runAdultCardsNotice } from '../../src/lib/privacy/cards-notice'
import { passportCard } from '../../src/lib/og/data'

// Turning 18 must not publish a card nobody chose: a person who was under 18 at any point keeps "show my cards on the web" off until they turn it on, and is told once, on
// the 18th birthday on their own calendar, what the switch is. The date writers store the switch off; the hourly job writes the note.
describe('the cards of people who were minors', () => {
  const suffix = uniqueSuffix()
  const tag = `ca${suffix}`
  const DAY = 24 * 3600_000
  // A fixed instant, so the birthdays below are known days; accounts are given creation dates relative to it.
  const NOW = new Date('2026-10-23T12:00:00Z')

  beforeAll(() => {
    process.env.DATABASE_URL = INTEGRATION_DATABASE_URL
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??= 'pk_test_integration'
    process.env.CLERK_SECRET_KEY ??= 'sk_test_integration'
  })
  afterAll(async () => {
    await removePeople(tag)
    await cleanupTestUsers(suffix)
  }, 120_000)

  /** A person who turns 18 on `birthday` (YYYY-MM-DD): born exactly 18 years earlier. */
  const bornFor = (birthday: string) => `${Number(birthday.slice(0, 4)) - 18}${birthday.slice(4)}`
  async function who(options: { birthday?: string; timezone?: string | null; createdAt?: Date; deleted?: boolean; birthDate?: string | null } = {}) {
    const person = await makePerson({
      tag,
      profile: false,
      birthDate: options.birthDate !== undefined ? options.birthDate : options.birthday ? bornFor(options.birthday) : null,
      timezone: options.timezone ?? 'UTC',
      deleted: options.deleted,
    })
    await testPrisma.user.update({ where: { id: person.id }, data: { createdAt: options.createdAt ?? new Date(NOW.getTime() - 60 * DAY) } })
    return person
  }
  const notes = (userId: string) => testPrisma.notification.findMany({ where: { userId, coalesceKey: CARDS_ADULT_KEY } })
  const stored = async (userId: string) => (await testPrisma.profile.findUnique({ where: { userId }, select: { showCardsOnWeb: true } }))?.showCardsOnWeb ?? null

  describe('when a date of birth is saved', () => {
    it('stores the switch off for a minor, so the 18th birthday cannot turn it on', async () => {
      const kid = await who()
      expect(await setBirthDate(testPrisma, kid.id, parseBirthDate(bornYearsAgo(17, 30))!)).toMatchObject({ kind: 'SET', band: 'MINOR' })
      expect(await stored(kid.id)).toBe(false)
      expect(await cardsAvailable(testPrisma, kid.id)).toBe(false)

      // The birthday comes (time passes): the stored choice is still off, and the card is still not drawn.
      await testPrisma.user.update({ where: { id: kid.id }, data: { birthDate: new Date(`${bornYearsAgo(18, 1)}T00:00:00Z`) } })
      expect(await cardsAvailable(testPrisma, kid.id)).toBe(true)
      expect(await stored(kid.id)).toBe(false)
      expect(await passportCard(testPrisma, kid.username!)).toBeNull()
      // Until they decide: then the card exists.
      await testPrisma.profile.update({ where: { userId: kid.id }, data: { showCardsOnWeb: true } })
      expect(await passportCard(testPrisma, kid.username!)).not.toBeNull()
    })

    it('stores it off for an adult whose account is older than their 18th birthday, and leaves an adult who joined as one alone', async () => {
      const grew = await who({ createdAt: new Date(Date.now() - 400 * DAY) })
      await setBirthDate(testPrisma, grew.id, parseBirthDate(bornYearsAgo(18, 30))!) // 18 for a month: the account was made at 17
      expect(await stored(grew.id)).toBe(false)

      const adult = await who({ createdAt: new Date(Date.now() - 400 * DAY) })
      await setBirthDate(testPrisma, adult.id, parseBirthDate(bornYearsAgo(30, 10))!)
      expect(await stored(adult.id)).toBeNull() // no row: the default, on
      expect(await cardsAvailable(testPrisma, adult.id)).toBe(true)
    })

    it('does the same when an admin corrects the date', async () => {
      const admin = await who({ birthDate: bornYearsAgo(40) })
      const wrongAdult = await who({ birthDate: bornYearsAgo(30), createdAt: new Date(Date.now() - 400 * DAY) })
      await testPrisma.profile.create({ data: { userId: wrongAdult.id, showCardsOnWeb: true } })
      const correction = { birthDate: bornYearsAgo(17, 40), reason: 'Verified with a document, the age was entered wrongly' }
      expect(await correctBirthDate(testPrisma, admin.id, wrongAdult.id, correction)).toMatchObject({ kind: 'CORRECTED', band: 'MINOR' })
      expect(await stored(wrongAdult.id)).toBe(false)

      // Corrected up to an adult: still off, and it is not switched on for them.
      const back = { birthDate: bornYearsAgo(25), reason: 'The first correction was itself wrong, document attached' }
      expect(await correctBirthDate(testPrisma, admin.id, wrongAdult.id, back)).toMatchObject({ kind: 'CORRECTED', band: 'ADULT' })
      expect(await stored(wrongAdult.id)).toBe(false)

      // An adult corrected to another adult age, who was never a minor on the platform, keeps what they chose.
      const stayed = await who({ birthDate: bornYearsAgo(30), createdAt: new Date(Date.now() - 5 * 365 * DAY) })
      await testPrisma.profile.create({ data: { userId: stayed.id, showCardsOnWeb: true } })
      await correctBirthDate(testPrisma, admin.id, stayed.id, { birthDate: bornYearsAgo(33), reason: 'Verified with a document, the age was entered wrongly' })
      expect(await stored(stayed.id)).toBe(true)
    })
  })

  describe('the note on the 18th birthday', () => {
    it('is written once, on the birthday, for someone who was a minor on the platform, with what the switch is and where to find it', async () => {
      const a = await who({ birthday: '2026-10-23' })
      const first = await runAdultCardsNotice(testPrisma, NOW)
      expect(first.notified).toBeGreaterThanOrEqual(1)
      const [note] = await notes(a.id)
      expect(note).toMatchObject({ type: 'SYSTEM', link: '/settings/privacy', metadata: { kind: 'CARDS_ADULT' } })
      expect(note.message).toMatch(/share|preview/i)
      expect(deliveryKindOf(note)).toBe('CARDS_ADULT')

      // Run again, and a day later: still one.
      await runAdultCardsNotice(testPrisma, NOW)
      await runAdultCardsNotice(testPrisma, new Date(NOW.getTime() + DAY))
      expect(await notes(a.id)).toHaveLength(1)
    })

    it('is not written the day before, and not for someone who joined as an adult or has gone', async () => {
      const tomorrow = await who({ birthday: '2026-10-24' })
      const joinedAdult = await who({ birthday: '2026-10-20', createdAt: new Date('2026-10-21T08:00:00Z') })
      const gone = await who({ birthday: '2026-10-23', deleted: true })
      const none = await who({ birthDate: null })
      await runAdultCardsNotice(testPrisma, NOW)
      for (const person of [tomorrow, joinedAdult, gone, none]) expect(await notes(person.id), person.username).toHaveLength(0)
    })

    it('catches up for a week after a missed day, and then lets it go', async () => {
      const sevenDaysAgo = await who({ birthday: '2026-10-16' })
      const eightDaysAgo = await who({ birthday: '2026-10-15' })
      await runAdultCardsNotice(testPrisma, NOW)
      expect(await notes(sevenDaysAgo.id)).toHaveLength(1)
      expect(await notes(eightDaysAgo.id)).toHaveLength(0)
    })

    it('waits for the birthday on the person’s own calendar: later in the west, and never before the UTC birthday', async () => {
      const berlin = await who({ birthday: '2026-10-23', timezone: 'Europe/Berlin' })
      const newYork = await who({ birthday: '2026-10-23', timezone: 'America/New_York' })
      const losAngeles = await who({ birthday: '2026-10-23', timezone: 'America/Los_Angeles' })
      const auckland = await who({ birthday: '2026-10-23', timezone: 'Pacific/Auckland' })

      // 03:00 UTC on the 23rd: the 23rd in Berlin and Auckland (and UTC), the 22nd in New York and Los Angeles.
      await runAdultCardsNotice(testPrisma, new Date('2026-10-23T03:00:00Z'))
      expect((await notes(berlin.id)).length).toBe(1)
      expect((await notes(auckland.id)).length).toBe(1)
      expect((await notes(newYork.id)).length).toBe(0)
      expect((await notes(losAngeles.id)).length).toBe(0)

      // 04:00 UTC is midnight in New York; Los Angeles is 07:00 UTC.
      await runAdultCardsNotice(testPrisma, new Date('2026-10-23T04:00:00Z'))
      expect((await notes(newYork.id)).length).toBe(1)
      expect((await notes(losAngeles.id)).length).toBe(0)
      await runAdultCardsNotice(testPrisma, new Date('2026-10-23T07:00:00Z'))
      expect((await notes(losAngeles.id)).length).toBe(1)
    })

    it('does not run ahead of the UTC calendar for a zone that is already on the next day', async () => {
      const kiritimati = await who({ birthday: '2026-10-23', timezone: 'Pacific/Kiritimati' })
      // 10:30 UTC on the 22nd is already the 23rd at UTC+14, but the age policy still counts the person as 17 for another 13 hours.
      await runAdultCardsNotice(testPrisma, new Date('2026-10-22T10:30:00Z'))
      expect(await notes(kiritimati.id)).toHaveLength(0)
      await runAdultCardsNotice(testPrisma, new Date('2026-10-23T00:00:00Z'))
      expect(await notes(kiritimati.id)).toHaveLength(1)
    })
  })

  it('the migration rule agrees with the code: the account made before the 18th birthday starts off', async () => {
    // The SQL of 20261024000100 and startsWithCardsOff() are the same rule; this checks the SQL on rows, on the day before and the day of the 18th birthday.
    const before = await who({ birthday: '2026-11-10', createdAt: new Date('2026-11-09T10:00:00Z') })
    const onDay = await who({ birthday: '2026-11-10', createdAt: new Date('2026-11-10T00:30:00Z') })
    for (const person of [before, onDay]) await testPrisma.profile.create({ data: { userId: person.id, showCardsOnWeb: true } })
    await testPrisma.$executeRawUnsafe(`
      UPDATE "Profile" p SET "showCardsOnWeb" = false FROM "User" u
      WHERE u."id" = p."userId" AND u."birthDate" IS NOT NULL AND p."showCardsOnWeb" = true
        AND (u."birthDate" + interval '18 years')::date > (u."createdAt" AT TIME ZONE 'UTC')::date
        AND u."id" IN ('${before.id}', '${onDay.id}')`)
    expect(await stored(before.id)).toBe(false)
    expect(await stored(onDay.id)).toBe(true)
  })
})

import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, promoteToAdmin, testPrisma, acceptLegalTerms } from './db'
import { bornYearsAgo } from './matching-fixtures'

// The platform age policy (docs/SAFETY.md): a date of birth is required to finish onboarding; under 16 is refused and kept out; 16 and 17 are minors, with
// a country and nothing finer; the date is set once and locked; an admin can correct it, with a reason, and it is never returned to anybody but its owner.
describe('the platform age policy', () => {
  const suffix = uniqueSuffix()
  const email = (label: string) => `age.${label}.${suffix}@test.dev`
  const username = (label: string) => `age${label}${suffix}`
  let admin: TestUser

  beforeAll(async () => {
    admin = await registerAndLogin(email('admin'), username('admin'))
    await promoteToAdmin(admin.userId)
  }, 60_000)
  afterAll(async () => {
    await cleanupTestUsers(suffix)
  }, 120_000)

  const user = (label: string) => registerAndLogin(email(label), username(label))
  const stored = (userId: string) => testPrisma.user.findUniqueOrThrow({ where: { id: userId }, select: { birthDate: true, birthDateRefusedAt: true, location: true } })
  const dateOnly = (date: Date | null) => date?.toISOString().slice(0, 10) ?? null

  describe('the onboarding route', () => {
    it('accepts a date of birth with the headline and makes it part of being onboarded', async () => {
      const me = await user('onboard')
      const skill = await testPrisma.skill.create({ data: { name: `Age Skill ${suffix}`, slug: `age-skill-${suffix}`, category: 'Test' } })
      await testPrisma.userSkill.create({ data: { userId: me.userId, skillId: skill.id } })

      const before = await req(me.jar, 'GET', '/api/users/me')
      expect(before.data).toMatchObject({ ageRequired: true, isMinor: false, ageRefused: false, onboardingComplete: false })

      const headlineOnly = await req(me.jar, 'PATCH', '/api/users', { headline: 'Builder of things' })
      expect(headlineOnly.status).toBe(200)
      expect((await req(me.jar, 'GET', '/api/users/me')).data.onboardingComplete).toBe(false)

      await acceptLegalTerms(me.userId)
      const done = await req(me.jar, 'PATCH', '/api/users', { birthDate: bornYearsAgo(30) })
      expect(done.status).toBe(200)
      expect(JSON.stringify(done.data)).not.toContain('birthDate')
      const after = await req(me.jar, 'GET', '/api/users/me')
      expect(after.data).toMatchObject({ ageRequired: false, isMinor: false, onboardingComplete: true })
      expect(JSON.stringify(after.data)).not.toContain(bornYearsAgo(30))
      expect(dateOnly((await stored(me.userId)).birthDate)).toBe(bornYearsAgo(30))
      await testPrisma.userSkill.deleteMany({ where: { skillId: skill.id } })
      await testPrisma.skill.delete({ where: { id: skill.id } })
    }, 60_000)

    it('refuses a malformed or impossible date', async () => {
      const me = await user('malformed')
      for (const birthDate of ['soon', '2030-01-01', '1995-02-31', '15/06/1995', '1800-01-01']) {
        const res = await req(me.jar, 'PATCH', '/api/users', { birthDate })
        expect(res.status, birthDate).toBe(400)
        expect(res.data.error.code).toBe('VALIDATION_FAILED')
      }
      expect((await stored(me.userId)).birthDate).toBeNull()
    }, 60_000)

    it('locks the date once set: the same date is fine, another is refused', async () => {
      const me = await user('lock')
      expect((await req(me.jar, 'PATCH', '/api/users', { birthDate: bornYearsAgo(25) })).status).toBe(200)
      expect((await req(me.jar, 'PATCH', '/api/users', { birthDate: bornYearsAgo(25) })).status).toBe(200)
      const other = await req(me.jar, 'PATCH', '/api/users', { birthDate: bornYearsAgo(40) })
      expect(other.status).toBe(409)
      expect(other.data.error.code).toBe('BIRTH_DATE_LOCKED')
      // The profile settings route is the same rule.
      const viaSettings = await req(me.jar, 'PATCH', '/api/users/me/profile', { birthDate: bornYearsAgo(41) })
      expect(viaSettings.data.error.code).toBe('BIRTH_DATE_LOCKED')
      expect(dateOnly((await stored(me.userId)).birthDate)).toBe(bornYearsAgo(25))
    }, 60_000)
  })

  describe('under 16', () => {
    it('is refused with a clear code, nothing but the moment is kept, and another date is not another chance', async () => {
      const kid = await user('kid')
      const refused = await req(kid.jar, 'PATCH', '/api/users', { birthDate: bornYearsAgo(15), headline: 'Hello' })
      expect(refused.status).toBe(403)
      expect(refused.data.error.code).toBe('AGE_BELOW_MINIMUM')
      expect(refused.data.error.params).toEqual({ minAge: 16 })
      const row = await stored(kid.userId)
      expect(row.birthDate).toBeNull()
      expect(row.birthDateRefusedAt).not.toBeNull()
      // The refusal is written without the date, and nothing else in the request was applied.
      const audit = await testPrisma.auditEvent.findFirst({ where: { userId: kid.userId, action: 'AGE_REFUSED' } })
      expect(JSON.stringify(audit)).not.toContain(bornYearsAgo(15))
      expect((await testPrisma.user.findUniqueOrThrow({ where: { id: kid.userId } })).headline).toBeNull()

      const retry = await req(kid.jar, 'PATCH', '/api/users/me/profile', { birthDate: bornYearsAgo(30) })
      expect(retry.status).toBe(403)
      expect(retry.data.error.code).toBe('AGE_BELOW_MINIMUM')
      expect((await stored(kid.userId)).birthDate).toBeNull()
    }, 60_000)

    it('is closed to everything but seeing the account and asking for a correction', async () => {
      const kid = await user('closed')
      await req(kid.jar, 'PATCH', '/api/users', { birthDate: bornYearsAgo(14) })
      for (const [method, path] of [['GET', '/api/dashboard'], ['GET', '/api/projects'], ['POST', '/api/projects'], ['GET', '/api/matches'], ['GET', '/api/discover'], ['PATCH', '/api/users']] as const) {
        const res = await req(kid.jar, method, path, method === 'GET' ? undefined : {})
        expect(res.status, `${method} ${path}`).toBe(403)
        expect(res.data.error.code).toBe('AGE_BELOW_MINIMUM')
      }
      const me = await req(kid.jar, 'GET', '/api/users/me')
      expect(me.status).toBe(200)
      expect(me.data).toMatchObject({ ageRefused: true, onboardingComplete: false })
      expect((await req(kid.jar, 'GET', '/api/users/me/profile')).status).toBe(200)
      const ask = await req(kid.jar, 'POST', '/api/reports', { reportedId: kid.userId, reason: 'BIRTHDATE_CORRECTION', description: 'I typed the year wrong, it should be 1998-04-02.' })
      expect(ask.status).toBe(201)
    }, 60_000)

    it('is let back in by an admin correction, which clears the refusal', async () => {
      const kid = await user('back')
      await req(kid.jar, 'PATCH', '/api/users', { birthDate: bornYearsAgo(15) })
      expect((await req(kid.jar, 'GET', '/api/dashboard')).status).toBe(403)
      const fix = await req(admin.jar, 'POST', `/api/admin/users/${kid.userId}/birthdate`, { birthDate: bornYearsAgo(27), reason: 'Typo at sign-up, confirmed with the person.' })
      expect(fix.status).toBe(200)
      expect(fix.data).toEqual({ id: kid.userId, ageBand: 'ADULT', isMinor: false, changed: true })
      expect((await stored(kid.userId)).birthDateRefusedAt).toBeNull()
      expect((await req(kid.jar, 'GET', '/api/dashboard')).status).toBe(200)
    }, 60_000)
  })

  describe('16 and 17: a minor', () => {
    it('is accepted, flagged, and limited to a country', async () => {
      const teen = await user('teen')
      await testPrisma.user.update({ where: { id: teen.userId }, data: { location: 'Pune, India' } })
      await testPrisma.profile.create({ data: { userId: teen.userId, countryCode: 'IN', city: 'Pune', cityKey: 'pune', campus: 'COEP', campusKey: 'coep' } })

      const set = await req(teen.jar, 'PATCH', '/api/users', { birthDate: bornYearsAgo(17) })
      expect(set.status).toBe(200)
      expect(await req(teen.jar, 'GET', '/api/users/me')).toMatchObject({ data: { isMinor: true, ageRefused: false, ageRequired: false } })
      // What was finer than a country is cleared when the date makes them a minor; the country stays.
      const profile = await testPrisma.profile.findUniqueOrThrow({ where: { userId: teen.userId } })
      expect(profile).toMatchObject({ countryCode: 'IN', city: null, cityKey: null, campus: null, campusKey: null })
      expect((await stored(teen.userId)).location).toBeNull()

      for (const body of [{ city: 'Pune' }, { campus: 'COEP' }]) {
        const res = await req(teen.jar, 'PATCH', '/api/users/me/profile', body)
        expect(res.status, JSON.stringify(body)).toBe(400)
        expect(res.data.error.code).toBe('MINOR_LOCATION_LIMITED')
      }
      const text = await req(teen.jar, 'PATCH', '/api/users', { location: 'Pune' })
      expect(text.data.error.code).toBe('MINOR_LOCATION_LIMITED')
      // A country is allowed, and so is clearing the rest.
      expect((await req(teen.jar, 'PATCH', '/api/users/me/profile', { countryCode: 'DE', city: null, campus: null })).status).toBe(200)
      expect((await testPrisma.profile.findUniqueOrThrow({ where: { userId: teen.userId } })).countryCode).toBe('DE')
    }, 60_000)

    it('stops being a minor on the eighteenth birthday with nothing to update', async () => {
      const almost = await user('almost')
      await testPrisma.user.update({ where: { id: almost.userId }, data: { birthDate: new Date(`${bornYearsAgo(18, -1)}T00:00:00Z`) } })
      expect((await req(almost.jar, 'GET', '/api/users/me')).data.isMinor).toBe(true)
      await testPrisma.user.update({ where: { id: almost.userId }, data: { birthDate: new Date(`${bornYearsAgo(18)}T00:00:00Z`) } })
      expect((await req(almost.jar, 'GET', '/api/users/me')).data.isMinor).toBe(false)
    }, 60_000)
  })

  describe('nobody else ever sees the date', () => {
    it('is in no response about another person, and only in its owner\'s settings', async () => {
      const a = await user('priv-a')
      const b = await user('priv-b')
      await req(a.jar, 'PATCH', '/api/users', { birthDate: '1991-03-07' })
      for (const path of [`/api/users/${a.userId}`, `/api/discover?search=${username('priv-a')}`, `/api/users?search=${username('priv-a')}`, `/api/users/${a.userId}/stats`]) {
        const text = JSON.stringify((await req(b.jar, 'GET', path)).data)
        expect(text, path).not.toMatch(/birthDate|1991-03-07/)
      }
      const own = await req(a.jar, 'GET', '/api/users/me/profile')
      expect(own.data.birthDate).toBe('1991-03-07')
      expect(JSON.stringify((await req(a.jar, 'GET', `/api/users/${a.userId}`)).data)).not.toMatch(/birthDate|1991-03-07/)
    }, 60_000)
  })

  describe('POST /api/admin/users/{id}/birthdate', () => {
    it('is for admins only, needs a date and a reason, and 404s on nobody', async () => {
      const target = await user('fix')
      const normal = await req(target.jar, 'POST', `/api/admin/users/${target.userId}/birthdate`, { birthDate: '1990-01-01', reason: 'because I said so ok' })
      expect(normal.status).toBe(403)
      expect((await req(null, 'POST', `/api/admin/users/${target.userId}/birthdate`, {})).status).toBe(401)
      for (const body of [{}, { birthDate: '1990-01-01' }, { reason: 'long enough reason' }, { birthDate: '1990-01-01', reason: 'short' }, { birthDate: 'x', reason: 'long enough reason' }, { birthDate: '1990-01-01', reason: 'long enough reason', extra: 1 }]) {
        const res = await req(admin.jar, 'POST', `/api/admin/users/${target.userId}/birthdate`, body)
        expect(res.status, JSON.stringify(body)).toBe(400)
      }
      const missing = await req(admin.jar, 'POST', '/api/admin/users/nobody/birthdate', { birthDate: '1990-01-01', reason: 'long enough reason' })
      expect(missing.status).toBe(404)
    }, 60_000)

    it('corrects a locked date, audits old and new with the reason, and never returns a date', async () => {
      const target = await user('audit')
      await req(target.jar, 'PATCH', '/api/users', { birthDate: '2001-05-05' })
      const res = await req(admin.jar, 'POST', `/api/admin/users/${target.userId}/birthdate`, { birthDate: '2000-05-05', reason: 'Document checked: the year was mistyped.' })
      expect(res.status).toBe(200)
      expect(res.data).toEqual({ id: target.userId, ageBand: 'ADULT', isMinor: false, changed: true })
      expect(JSON.stringify(res.data)).not.toMatch(/2000|2001/)
      expect(dateOnly((await stored(target.userId)).birthDate)).toBe('2000-05-05')
      const audit = await testPrisma.auditEvent.findFirstOrThrow({ where: { targetId: target.userId, action: 'BIRTH_DATE_CORRECTED' } })
      expect(audit.userId).toBe(admin.userId)
      expect(audit.oldValue).toEqual({ birthDate: '2001-05-05' })
      expect(audit.newValue).toMatchObject({ birthDate: '2000-05-05', reason: 'Document checked: the year was mistyped.', band: 'ADULT' })
      // The same date again is a correction that changes nothing, and is still audited.
      const same = await req(admin.jar, 'POST', `/api/admin/users/${target.userId}/birthdate`, { birthDate: '2000-05-05', reason: 'Checked again, still right.' })
      expect(same.data.changed).toBe(false)
    }, 60_000)

    it('does not admit anyone under 16, and a correction to 17 makes a minor and clears their place', async () => {
      const target = await user('corrmin')
      await req(target.jar, 'PATCH', '/api/users', { birthDate: bornYearsAgo(40) })
      await testPrisma.profile.create({ data: { userId: target.userId, countryCode: 'IN', city: 'Delhi', cityKey: 'delhi' } })
      const tooYoung = await req(admin.jar, 'POST', `/api/admin/users/${target.userId}/birthdate`, { birthDate: bornYearsAgo(12), reason: 'A parent wrote in to say so.' })
      expect(tooYoung.status).toBe(403)
      expect(tooYoung.data.error.code).toBe('AGE_BELOW_MINIMUM')
      expect(dateOnly((await stored(target.userId)).birthDate)).toBe(bornYearsAgo(40))

      const minor = await req(admin.jar, 'POST', `/api/admin/users/${target.userId}/birthdate`, { birthDate: bornYearsAgo(17), reason: 'A parent wrote in with the right date.' })
      expect(minor.data).toMatchObject({ ageBand: 'MINOR', isMinor: true })
      expect(await testPrisma.profile.findUniqueOrThrow({ where: { userId: target.userId } })).toMatchObject({ countryCode: 'IN', city: null, cityKey: null })
    }, 60_000)
  })

  describe('asking for a correction through the report flow', () => {
    it('is a report of the caller against themselves, needs the words, and is kept once while pending', async () => {
      const me = await user('ask')
      const other = await user('asked')
      const body = { reason: 'BIRTHDATE_CORRECTION', description: 'The year is wrong, it should be 1999-08-08.' }
      const forOther = await req(me.jar, 'POST', '/api/reports', { ...body, reportedId: other.userId })
      expect(forOther.status).toBe(400)
      expect(forOther.data.error.code).toBe('BIRTHDATE_CORRECTION_SELF_ONLY')
      const bare = await req(me.jar, 'POST', '/api/reports', { reportedId: me.userId, reason: 'BIRTHDATE_CORRECTION' })
      expect(bare.status).toBe(400)
      expect(bare.data.error.code).toBe('VALIDATION_FAILED')
      const filed = await req(me.jar, 'POST', '/api/reports', { ...body, reportedId: me.userId })
      expect(filed.status).toBe(201)
      expect(filed.data).toMatchObject({ reason: 'BIRTHDATE_CORRECTION', status: 'PENDING', reportedId: me.userId, reporterId: me.userId })
      const again = await req(me.jar, 'POST', '/api/reports', { ...body, reportedId: me.userId })
      expect(again.status).toBe(409)
      // Reporting oneself for any other reason is still not allowed.
      const spam = await req(me.jar, 'POST', '/api/reports', { reportedId: me.userId, reason: 'SPAM' })
      expect(spam.data.error.code).toBe('CANNOT_REPORT_SELF')
      // An admin sees it in the queue.
      const queue = await req(admin.jar, 'GET', '/api/reports?status=PENDING&limit=50')
      expect(queue.data.reports.some((report: { id: string }) => report.id === filed.data.id)).toBe(true)
    }, 60_000)
  })
})

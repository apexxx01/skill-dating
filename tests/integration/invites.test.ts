import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import type { User } from '@clerk/nextjs/server'
import { INTEGRATION_DATABASE_URL } from './config'
import { cleanupTestUsers, promoteToAdmin, testPrisma } from './db'
import { registerAndLogin, req, uniqueSuffix, type TestUser } from './helpers'
import { bornYearsAgo, makePerson, removePeople } from './matching-fixtures'
import { INVITE_REWARD_CAP, qualifyInvites, redeemInvite } from '../../src/lib/invites/invites'
import { syncClerkUser } from '../../src/lib/user-sync'

const DAY_MS = 24 * 60 * 60 * 1000

// Invites: a personal code per person, campaign codes from admins, attribution, and the XP an inviter earns only when the invitee has finished onboarding and done a first real
// thing, through the rewards engine and its checks. Time is passed in, so "a week old" needs no waiting.
describe('invites', () => {
  const suffix = uniqueSuffix().toLowerCase()
  const tag = `iv${suffix}`
  let n = 0
  let admin: TestUser
  const campaigns: string[] = []
  const campusIds: string[] = []

  beforeAll(async () => {
    process.env.DATABASE_URL = INTEGRATION_DATABASE_URL
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??= 'pk_test_integration'
    process.env.CLERK_SECRET_KEY ??= 'sk_test_integration'
    const name = `ivadmin${suffix}`
    admin = await registerAndLogin(`${name}@test.dev`, name)
    await promoteToAdmin(admin.userId)
  }, 60_000)
  afterAll(async () => {
    await testPrisma.inviteCode.deleteMany({ where: { id: { in: campaigns } } })
    await testPrisma.campus.deleteMany({ where: { id: { in: campusIds } } })
    await testPrisma.fraudSignal.deleteMany({ where: { fingerprint: { startsWith: tag } } })
    await removePeople(tag)
    await cleanupTestUsers(suffix)
  }, 120_000)

  // --- fixtures straight in the database -------------------------------------------------------------------------------------
  async function person(over: { ageDays?: number; email?: string; verified?: boolean; onboarded?: boolean } = {}) {
    const made = await makePerson({ tag, profile: false, ageDays: over.ageDays ?? 30, emailVerified: over.verified ?? true, birthDate: over.onboarded ? bornYearsAgo(25, 50) : null })
    if (over.email) await testPrisma.user.update({ where: { id: made.id }, data: { email: over.email } })
    if (over.onboarded) await onboard(made.id)
    return made
  }
  async function onboard(userId: string) {
    const skill = await testPrisma.skill.upsert({ where: { slug: `iv-${tag}` }, update: {}, create: { name: `Skill ${tag}`, slug: `iv-${tag}`, category: 'Test' } })
    await testPrisma.user.update({ where: { id: userId }, data: { headline: 'Builds things', birthDate: new Date(`${bornYearsAgo(25, 50)}T00:00:00Z`) } })
    await testPrisma.userSkill.upsert({ where: { userId_skillId: { userId, skillId: skill.id } }, update: {}, create: { userId, skillId: skill.id } })
  }
  const act = (userId: string, name = 'post_created') => testPrisma.productEvent.create({ data: { userId, name } })
  const codeOf = async (userId: string) => (await testPrisma.inviteCode.create({ data: { code: `T${Math.random().toString(36).slice(2, 9).toUpperCase().padEnd(7, 'X')}`, kind: 'PERSONAL', ownerId: userId, maxUses: 50 } })).code
  const redemption = (inviteeId: string) => testPrisma.inviteRedemption.findUniqueOrThrow({ where: { inviteeId } })
  const inviteXp = async (userId: string) => (await testPrisma.xPEvent.findMany({ where: { userId, type: 'INVITE_QUALIFIED' } })).reduce((sum, row) => sum + row.amount, 0)
  /** Makes the account a week and a day old: the platform's trust is in the age of the account, which a test cannot wait for. */
  const age = (userId: string) => testPrisma.user.update({ where: { id: userId }, data: { createdAt: new Date(Date.now() - 8 * DAY_MS) } })

  describe('GET /api/invites/me', () => {
    it('makes a personal code on first use, the same one every time, and says how it is doing', async () => {
      const name = `ivme${suffix}`
      const me = await registerAndLogin(`${name}@test.dev`, name)
      const first = await req(me.jar, 'GET', '/api/invites/me')
      expect(first.status).toBe(200)
      expect(first.data.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/)
      expect(first.data).toMatchObject({ redeemed: 0, qualified: 0, rewarded: 0, rewardCap: INVITE_REWARD_CAP, rewardsLeft: INVITE_REWARD_CAP, xpPerInvite: 40 })
      expect(first.data.link).toContain(`/signup?invite=${first.data.code}`)
      expect((await req(me.jar, 'GET', '/api/invites/me')).data.code).toBe(first.data.code)
      expect(await testPrisma.inviteCode.count({ where: { ownerId: me.userId } })).toBe(1)
      expect((await req(null, 'GET', '/api/invites/me')).status).toBe(401)
    })
  })

  describe('POST /api/invites/redeem', () => {
    it('attributes a new account to the code, once, however the code is typed', async () => {
      const owner = await person()
      const code = await codeOf(owner.id)
      const name = `ivr${suffix}${n++}`
      const joiner = await registerAndLogin(`${name}@test.dev`, name)
      const typed = `${code.slice(0, 4).toLowerCase()}-${code.slice(4).toLowerCase()}`
      const ok = await req(joiner.jar, 'POST', '/api/invites/redeem', { code: typed })
      expect(ok.status, JSON.stringify(ok.data)).toBe(200)
      expect(ok.data).toEqual({ redeemed: true, campusId: null })
      expect(await redemption(joiner.userId)).toMatchObject({ inviterId: owner.id, status: 'PENDING', reason: null })
      expect((await testPrisma.inviteCode.findUniqueOrThrow({ where: { code } })).uses).toBe(1)
      const again = await req(joiner.jar, 'POST', '/api/invites/redeem', { code })
      expect(again.status).toBe(409)
      expect(again.data.error.code).toBe('INVITE_ALREADY_REDEEMED')
      expect((await testPrisma.inviteCode.findUniqueOrThrow({ where: { code } })).uses).toBe(1)
    })

    it('refuses your own code, an unknown code and one that is switched off, ran out or expired, with the same answer for all of them', async () => {
      const owner = await registerAndLogin(`ivo${suffix}@test.dev`, `ivo${suffix}`)
      const ownCode = (await req(owner.jar, 'GET', '/api/invites/me')).data.code
      const own = await req(owner.jar, 'POST', '/api/invites/redeem', { code: ownCode })
      expect(own.status).toBe(400)
      expect(own.data.error.code).toBe('INVITE_OWN_CODE')

      const holder = await person()
      const off = await testPrisma.inviteCode.create({ data: { code: `OFF${suffix.toUpperCase()}`.slice(0, 12), kind: 'PERSONAL', ownerId: holder.id, disabledAt: new Date() } })
      const camp = (extra: Record<string, unknown>, label: string) => req(admin.jar, 'POST', '/api/admin/invites', { label, ...extra })
      const full = await camp({ maxUses: 1 }, `Full ${suffix}`)
      const past = await testPrisma.inviteCode.create({ data: { code: `OLD${suffix.toUpperCase()}`.slice(0, 12), kind: 'CAMPAIGN', label: 'Old', expiresAt: new Date(Date.now() - 1000) } })
      campaigns.push(past.id, full.data.code.id)
      await testPrisma.inviteCode.update({ where: { id: full.data.code.id }, data: { uses: 1 } })

      const name = `ivx${suffix}${n++}`
      const joiner = await registerAndLogin(`${name}@test.dev`, name)
      const answers = new Set<string>()
      for (const code of ['NOSUCHCODE', off.code, full.data.code.code, past.code, '', 'a']) {
        const res = await req(joiner.jar, 'POST', '/api/invites/redeem', { code })
        answers.add(`${res.status} ${res.data.error?.code}`)
      }
      expect([...answers].filter((answer) => !answer.startsWith('400 VALIDATION_FAILED'))).toEqual(['404 INVITE_CODE_INVALID'])
      expect(await testPrisma.inviteRedemption.count({ where: { inviteeId: joiner.userId } })).toBe(0)
    })

    it('closes after the first 14 days of an account', async () => {
      const owner = await person()
      const code = await codeOf(owner.id)
      const name = `ivw${suffix}${n++}`
      const old = await registerAndLogin(`${name}@test.dev`, name)
      await testPrisma.user.update({ where: { id: old.userId }, data: { createdAt: new Date(Date.now() - 15 * DAY_MS) } })
      const res = await req(old.jar, 'POST', '/api/invites/redeem', { code })
      expect(res.status).toBe(409)
      expect(res.data.error).toMatchObject({ code: 'INVITE_WINDOW_CLOSED', params: { days: 14 } })
    })

    it('does not let two accounts take the last use of a code', async () => {
      const made = await req(admin.jar, 'POST', '/api/admin/invites', { label: `Last use ${suffix}`, maxUses: 1 })
      campaigns.push(made.data.code.id)
      const a = await person({ ageDays: 1 })
      const b = await person({ ageDays: 1 })
      const results = await Promise.all([redeemInvite(testPrisma, a.id, made.data.code.code), redeemInvite(testPrisma, b.id, made.data.code.code)])
      expect(results.filter((r) => r.ok)).toHaveLength(1)
      expect((await testPrisma.inviteCode.findUniqueOrThrow({ where: { id: made.data.code.id } })).uses).toBe(1)
    })

    it('tags a sign-up that carries the code in its Clerk metadata as the invitee', async () => {
      const owner = await person()
      const code = await codeOf(owner.id)
      const clerkId = `user_${tag}attr`
      const email = `attr${suffix}@test.dev`
      const clerkUser = {
        id: clerkId,
        primaryEmailAddressId: 'e1',
        emailAddresses: [{ id: 'e1', emailAddress: email, verification: { status: 'verified' } }],
        phoneNumbers: [],
        externalAccounts: [],
        firstName: 'Attr',
        lastName: 'Ibute',
        username: `attr${suffix}`,
        hasImage: false,
        imageUrl: '',
        unsafeMetadata: { inviteCode: code },
      } as unknown as User
      const synced = await syncClerkUser(clerkUser, testPrisma)
      expect(await redemption(synced.id)).toMatchObject({ inviterId: owner.id, status: 'PENDING' })
      // Seeing the same account again changes nothing, and a bad code never stops a sign-up.
      await syncClerkUser(clerkUser, testPrisma)
      expect(await testPrisma.inviteRedemption.count({ where: { inviteeId: synced.id } })).toBe(1)
      const other = { ...clerkUser, id: `${clerkId}2`, emailAddresses: [{ id: 'e1', emailAddress: `attr2${suffix}@test.dev`, verification: { status: 'verified' } }], username: `attrtwo${suffix}`, unsafeMetadata: { inviteCode: 'NOSUCHCODE' } } as unknown as User
      const second = await syncClerkUser(other, testPrisma)
      expect(await testPrisma.inviteRedemption.count({ where: { inviteeId: second.id } })).toBe(0)
    })
  })

  describe('earning XP', () => {
    it('pays the inviter once, when the invitee has finished onboarding AND done a first real thing, and the invitee is a trusted account', async () => {
      const inviter = await person()
      const invitee = await person({ ageDays: 1 })
      const code = await codeOf(inviter.id)
      expect((await redeemInvite(testPrisma, invitee.id, code)).ok).toBe(true)

      // Nothing yet: not onboarded.
      await qualifyInvites(testPrisma)
      expect((await redemption(invitee.id)).status).toBe('PENDING')
      // Onboarded, but nothing done.
      await onboard(invitee.id)
      await qualifyInvites(testPrisma)
      expect((await redemption(invitee.id)).status).toBe('PENDING')
      // Something done that is not a real action (looking at a drop), then a real one.
      await act(invitee.id, 'drop_viewed')
      await qualifyInvites(testPrisma)
      expect((await redemption(invitee.id)).status).toBe('PENDING')
      await act(invitee.id, 'post_created')
      const early = await qualifyInvites(testPrisma)
      expect(early).toMatchObject({ qualified: 1, rewarded: 0, waiting: 1 })
      // Qualified, but the invitee is a day old: the platform pays for a trusted account, so the payment waits for the week.
      expect(await redemption(invitee.id)).toMatchObject({ status: 'QUALIFIED', reason: 'WAITING_TRUST', rewardedAt: null })
      expect(await inviteXp(inviter.id)).toBe(0)

      await age(invitee.id)
      const later = await qualifyInvites(testPrisma)
      expect(later.rewarded).toBe(1)
      expect(await redemption(invitee.id)).toMatchObject({ status: 'REWARDED', reason: null })
      expect(await inviteXp(inviter.id)).toBe(40)
      const paid = await testPrisma.xPEvent.findFirstOrThrow({ where: { userId: inviter.id, type: 'INVITE_QUALIFIED' } })
      expect(paid).toMatchObject({ sourceType: 'INVITE', sourceId: (await redemption(invitee.id)).id, amount: 40 })
      expect((await testPrisma.user.findUniqueOrThrow({ where: { id: inviter.id } })).xp).toBe(40)

      // Run again and again: never paid twice.
      await qualifyInvites(testPrisma)
      await qualifyInvites(testPrisma, new Date(Date.now() + 9 * DAY_MS))
      expect(await inviteXp(inviter.id)).toBe(40)
    })

    it('pays through the stats the inviter sees', async () => {
      const name = `ivst${suffix}`
      const inviter = await registerAndLogin(`${name}@test.dev`, name)
      await testPrisma.user.update({ where: { id: inviter.userId }, data: { createdAt: new Date(Date.now() - 30 * DAY_MS), isEmailVerified: true } })
      const code = (await req(inviter.jar, 'GET', '/api/invites/me')).data.code as string
      const invitee = await person({ ageDays: 1, onboarded: true })
      await act(invitee.id)
      await redeemInvite(testPrisma, invitee.id, code)
      await age(invitee.id)
      await qualifyInvites(testPrisma)
      expect((await req(inviter.jar, 'GET', '/api/invites/me')).data).toMatchObject({ redeemed: 1, qualified: 1, rewarded: 1, rewardsLeft: INVITE_REWARD_CAP - 1 })
    })

    it('pays nobody for a campaign code: it only records that the invitee got started', async () => {
      const made = await req(admin.jar, 'POST', '/api/admin/invites', { label: `Waitlist ${suffix}` })
      campaigns.push(made.data.code.id)
      const invitee = await person({ ageDays: 1, onboarded: true })
      await act(invitee.id)
      expect((await redeemInvite(testPrisma, invitee.id, made.data.code.code)).ok).toBe(true)
      expect(await redemption(invitee.id)).toMatchObject({ inviterId: null })
      const result = await qualifyInvites(testPrisma)
      expect(result.rewarded).toBe(0)
      expect(await redemption(invitee.id)).toMatchObject({ status: 'QUALIFIED' })
      expect(await testPrisma.xPEvent.count({ where: { type: 'INVITE_QUALIFIED', sourceId: (await redemption(invitee.id)).id } })).toBe(0)
    })

    it('rejects, quietly and with a record, the same person on two accounts: the same mailbox up to dots and tags', async () => {
      const inviter = await person({ email: `same.person${suffix}@gmail.com` })
      const invitee = await person({ ageDays: 1, email: `s.a.m.e.person${suffix}+two@gmail.com`, onboarded: true })
      const code = await codeOf(inviter.id)
      // The answer says it worked: nothing tells a farmer which rule caught them.
      expect((await redeemInvite(testPrisma, invitee.id, code)).ok).toBe(true)
      expect(await redemption(invitee.id)).toMatchObject({ status: 'REJECTED', reason: 'SAME_EMAIL' })
      await act(invitee.id)
      await qualifyInvites(testPrisma)
      expect(await inviteXp(inviter.id)).toBe(0)
      expect(await testPrisma.integritySignal.count({ where: { kind: 'invite_suspect', userId: inviter.id } })).toBe(1)
    })

    it('rejects an invite when either account is at a high risk level, or the two are in an open collusion finding', async () => {
      const code = async (inviter: { id: string }) => codeOf(inviter.id)
      // Inviter at a high risk level.
      const riskyInviter = await person()
      const a = await person({ ageDays: 10, onboarded: true })
      await act(a.id)
      await redeemInvite(testPrisma, a.id, await code(riskyInviter))
      await testPrisma.userRisk.create({ data: { userId: riskyInviter.id, score: 90, level: 'HIGH' } })
      // The invitee at a high risk level.
      const inviter = await person()
      const riskyInvitee = await person({ ageDays: 10, onboarded: true })
      await act(riskyInvitee.id)
      await redeemInvite(testPrisma, riskyInvitee.id, await code(inviter))
      await testPrisma.userRisk.create({ data: { userId: riskyInvitee.id, score: 90, level: 'HIGH' } })
      // Both in an open collusion finding.
      const pairInviter = await person()
      const pairInvitee = await person({ ageDays: 10, onboarded: true })
      await act(pairInvitee.id)
      await redeemInvite(testPrisma, pairInvitee.id, await code(pairInviter))
      await testPrisma.fraudSignal.create({ data: { type: 'MUTUAL_BOOST', score: 80, memberIds: [pairInviter.id, pairInvitee.id], evidence: {}, fingerprint: `${tag}-pair`, windowStart: new Date(), windowEnd: new Date() } })

      await qualifyInvites(testPrisma)
      expect(await redemption(a.id)).toMatchObject({ status: 'REJECTED', reason: 'RISK' })
      expect(await redemption(riskyInvitee.id)).toMatchObject({ status: 'REJECTED', reason: 'RISK' })
      expect(await redemption(pairInvitee.id)).toMatchObject({ status: 'REJECTED', reason: 'FRAUD' })
      for (const who of [riskyInviter, inviter, pairInviter]) expect(await inviteXp(who.id)).toBe(0)
    })

    it('waits for an invitee whose email is not verified, and pays when it is', async () => {
      const inviter = await person()
      const invitee = await person({ ageDays: 10, verified: false, onboarded: true })
      await act(invitee.id)
      await redeemInvite(testPrisma, invitee.id, await codeOf(inviter.id))
      await qualifyInvites(testPrisma)
      expect(await redemption(invitee.id)).toMatchObject({ status: 'QUALIFIED', reason: 'WAITING_TRUST' })
      await testPrisma.user.update({ where: { id: invitee.id }, data: { isEmailVerified: true } })
      await qualifyInvites(testPrisma)
      expect(await redemption(invitee.id)).toMatchObject({ status: 'REWARDED' })
    })

    it('does not pay when the two have blocked each other', async () => {
      const inviter = await person()
      const invitee = await person({ ageDays: 10, onboarded: true })
      await act(invitee.id)
      await redeemInvite(testPrisma, invitee.id, await codeOf(inviter.id))
      await testPrisma.block.create({ data: { blockerId: invitee.id, blockedId: inviter.id } })
      await qualifyInvites(testPrisma)
      expect(await redemption(invitee.id)).toMatchObject({ status: 'REJECTED', reason: 'BLOCKED' })
      expect(await inviteXp(inviter.id)).toBe(0)
    })

    it('stops paying one person after the lifetime cap of rewarded invites, and keeps the rest qualified', async () => {
      const inviter = await person()
      const code = await codeOf(inviter.id)
      const codeRow = await testPrisma.inviteCode.findUniqueOrThrow({ where: { code } })
      for (let i = 0; i < INVITE_REWARD_CAP; i++) {
        const done = await person()
        await testPrisma.inviteRedemption.create({ data: { codeId: codeRow.id, inviteeId: done.id, inviterId: inviter.id, status: 'REWARDED', rewardedAt: new Date() } })
      }
      const invitee = await person({ ageDays: 10, onboarded: true })
      await act(invitee.id)
      await redeemInvite(testPrisma, invitee.id, code)
      await qualifyInvites(testPrisma)
      expect(await redemption(invitee.id)).toMatchObject({ status: 'QUALIFIED', reason: 'CAP' })
      expect(await inviteXp(inviter.id)).toBe(0)
    })

    it('pays at most three invites a day, the rest the next day', async () => {
      const inviter = await person()
      const code = await codeOf(inviter.id)
      const invitees = []
      for (let i = 0; i < 4; i++) {
        const invitee = await person({ ageDays: 10, onboarded: true })
        await act(invitee.id)
        await redeemInvite(testPrisma, invitee.id, code)
        invitees.push(invitee)
      }
      const result = await qualifyInvites(testPrisma)
      expect(result.rewarded).toBe(3)
      expect(await inviteXp(inviter.id)).toBe(120)
      const statuses = await Promise.all(invitees.map(async (invitee) => (await redemption(invitee.id)).status))
      expect(statuses.filter((status) => status === 'REWARDED')).toHaveLength(3)
      expect(statuses.filter((status) => status === 'QUALIFIED')).toHaveLength(1)
    })

    it('lets go of an invite that never got started, and of a payment that waited too long', async () => {
      const inviter = await person()
      const code = await codeOf(inviter.id)
      const idle = await person({ ageDays: 40 })
      await testPrisma.inviteRedemption.upsert({
        where: { inviteeId: idle.id },
        update: { redeemedAt: new Date(Date.now() - 31 * DAY_MS) },
        create: { codeId: (await testPrisma.inviteCode.findUniqueOrThrow({ where: { code } })).id, inviteeId: idle.id, inviterId: inviter.id, redeemedAt: new Date(Date.now() - 31 * DAY_MS) },
      })
      const stuck = await person({ ageDays: 70 })
      await testPrisma.inviteRedemption.create({
        data: { codeId: (await testPrisma.inviteCode.findUniqueOrThrow({ where: { code } })).id, inviteeId: stuck.id, inviterId: inviter.id, status: 'QUALIFIED', reason: 'WAITING_TRUST', redeemedAt: new Date(Date.now() - 61 * DAY_MS), qualifiedAt: new Date(Date.now() - 60 * DAY_MS) },
      })
      await qualifyInvites(testPrisma)
      expect((await redemption(idle.id)).status).toBe('EXPIRED')
      expect((await redemption(stuck.id)).status).toBe('EXPIRED')
    })
  })

  describe('campaign codes (admin)', () => {
    it('creates one with a code of its own or a random one, a label, a campus, a limit and an expiry, and lists how each is doing', async () => {
      const campus = await req(admin.jar, 'POST', '/api/admin/campuses', { name: `Invite Campus ${suffix}`, emailDomains: [`ic${suffix}.edu`] })
      campusIds.push(campus.data.campus.id)
      const custom = await req(admin.jar, 'POST', '/api/admin/invites', { label: `Partner ${suffix}`, code: `iisc-${suffix}`, campusId: campus.data.campus.id, maxUses: 100, expiresAt: new Date(Date.now() + 30 * DAY_MS).toISOString() })
      expect(custom.status, JSON.stringify(custom.data)).toBe(201)
      expect(custom.data.code).toMatchObject({ code: `IISC${suffix}`.toUpperCase().replace(/-/g, ''), kind: 'CAMPAIGN', label: `Partner ${suffix}`, campusId: campus.data.campus.id, maxUses: 100, uses: 0 })
      campaigns.push(custom.data.code.id)
      const random = await req(admin.jar, 'POST', '/api/admin/invites', { label: `Random ${suffix}` })
      campaigns.push(random.data.code.id)
      expect(random.data.code.code).toMatch(/^[A-Z2-9]{8}$/)
      expect((await req(admin.jar, 'POST', '/api/admin/invites', { label: 'Dup code', code: `iisc-${suffix}` })).data.error.code).toBe('INVITE_CODE_TAKEN')
      expect((await req(admin.jar, 'POST', '/api/admin/invites', { label: 'Bad campus', campusId: 'nope' })).data.error.code).toBe('CAMPUS_NOT_FOUND')
      for (const body of [{ label: 'x' }, { label: 'Fine label', code: 'a b' }, { label: 'Fine label', maxUses: 0 }, { label: 'Fine label', expiresAt: 'tomorrow' }, { label: 'Fine label', extra: true }]) {
        expect((await req(admin.jar, 'POST', '/api/admin/invites', body)).status, JSON.stringify(body)).toBe(400)
      }

      // Somebody joins with it, and the campus it suggests shows on their campus page.
      const invitee = await person({ ageDays: 1, onboarded: true })
      await act(invitee.id)
      await redeemInvite(testPrisma, invitee.id, `iisc-${suffix}`)
      await qualifyInvites(testPrisma)
      const list = await req(admin.jar, 'GET', '/api/admin/invites')
      const row = list.data.codes.find((c: { id: string }) => c.id === custom.data.code.id)
      expect(row).toMatchObject({ uses: 1, qualified: 1, rejected: 0, campus: { id: campus.data.campus.id } })
    })

    it('switches a code off and on, and changes its limit; a personal code can only be switched', async () => {
      const made = await req(admin.jar, 'POST', '/api/admin/invites', { label: `Toggle ${suffix}` })
      campaigns.push(made.data.code.id)
      const id = made.data.code.id
      const off = await req(admin.jar, 'PATCH', `/api/admin/invites/${id}`, { disabled: true, maxUses: 5, label: 'Toggled' })
      expect(off.data.code).toMatchObject({ maxUses: 5, label: 'Toggled' })
      expect(off.data.code.disabledAt).toBeTruthy()
      const joiner = await person({ ageDays: 1 })
      expect((await redeemInvite(testPrisma, joiner.id, made.data.code.code)).ok).toBe(false)
      expect((await req(admin.jar, 'PATCH', `/api/admin/invites/${id}`, { disabled: false })).data.code.disabledAt).toBeNull()
      expect((await redeemInvite(testPrisma, joiner.id, made.data.code.code)).ok).toBe(true)

      const owner = await person()
      const personal = await testPrisma.inviteCode.create({ data: { code: `P${Math.random().toString(36).slice(2, 9).toUpperCase().padEnd(7, 'Y')}`, kind: 'PERSONAL', ownerId: owner.id } })
      expect((await req(admin.jar, 'PATCH', `/api/admin/invites/${personal.id}`, { maxUses: 3 })).status).toBe(400)
      expect((await req(admin.jar, 'PATCH', `/api/admin/invites/${personal.id}`, { disabled: true })).status).toBe(200)
      expect((await req(admin.jar, 'PATCH', '/api/admin/invites/nope', { disabled: true })).data.error.code).toBe('INVITE_NOT_FOUND')
      expect((await req(admin.jar, 'PATCH', `/api/admin/invites/${id}`, {})).status).toBe(400)
    })

    it('is for admins only', async () => {
      const name = `ivnot${suffix}`
      const member = await registerAndLogin(`${name}@test.dev`, name)
      expect((await req(member.jar, 'GET', '/api/admin/invites')).status).toBe(403)
      expect((await req(member.jar, 'POST', '/api/admin/invites', { label: 'Nope nope' })).status).toBe(403)
      expect((await req(member.jar, 'PATCH', '/api/admin/invites/x', { disabled: true })).status).toBe(403)
    })
  })
})

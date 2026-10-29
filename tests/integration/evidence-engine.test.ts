import { createPublicKey, verify } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { req, registerAndLogin, syntheticIp, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, promoteToAdmin, testPrisma } from './db'
import { INTEGRATION_BASE_URL } from './config'
import { bornYearsAgo } from './matching-fixtures'
import versions from '../../src/config/legal-versions.json'
import { canonicalize } from '../../src/lib/evidence/canonical'
import { FIXTURE_KID } from '../../src/lib/evidence/signing'
import { ACHIEVEMENT_DEFINITIONS } from '../../src/lib/achievement-definitions'

// The evidence engine end to end (docs/PROOF.md), against the server's in-memory GitHub, which answers from tests/integration/fixtures/github.json: nothing
// here reaches GitHub. Each person below is given one of the fixture GitHub ids directly (as Clerk would on connecting GitHub).
describe('evidence engine', () => {
  const suffix = uniqueSuffix()
  let admin: TestUser
  let admin2: TestUser
  let n = 0
  let skillId: string

  async function person(label: string, githubId: string | null, options: { consent?: boolean; birthDate?: string | null; claims?: string[] } = {}): Promise<TestUser> {
    const name = `ev${label}${suffix}${n++}`
    const user = await registerAndLogin(`${name}@test.dev`, name)
    await testPrisma.user.update({ where: { id: user.userId }, data: { githubId, birthDate: options.birthDate === undefined ? new Date(bornYearsAgo(25)) : options.birthDate ? new Date(options.birthDate) : null } })
    if (options.consent !== false) await testPrisma.consentRecord.create({ data: { userId: user.userId, type: 'GITHUB_SYNC', version: versions.GITHUB_SYNC, source: 'api' } })
    await testPrisma.userSkill.create({ data: { userId: user.userId, skillId } })
    for (const [i, url] of (options.claims ?? []).entries()) await testPrisma.project.create({ data: { name: `Claim ${i}`, slug: `${name}-claim-${i}`, ownerId: user.userId, githubUrl: url } })
    return user
  }

  const sync = async (userId: string) => {
    const run = await req(admin.jar, 'POST', '/api/admin/jobs/github/sync', { data: { userId } })
    expect(run.status, JSON.stringify(run.data)).toBe(200)
    return run.data.result
  }
  const anon = (path: string, headers: Record<string, string> = {}) => fetch(INTEGRATION_BASE_URL + path, { headers: { 'x-forwarded-for': syntheticIp(), ...headers } })
  const setKill = async (key: string, enabled: boolean) => expect((await req(admin.jar, 'PATCH', `/api/admin/flags/${key}`, { enabled })).status).toBe(200)

  beforeAll(async () => {
    const skill = await testPrisma.skill.findUnique({ where: { slug: 'typescript' } })
    skillId = (skill ?? (await testPrisma.skill.create({ data: { name: 'TypeScript', slug: 'typescript', category: 'Engineering' } }))).id
    admin = await registerAndLogin(`eva${suffix}@test.dev`, `eva${suffix}`)
    admin2 = await registerAndLogin(`evb${suffix}@test.dev`, `evb${suffix}`)
    await promoteToAdmin(admin.userId)
    await promoteToAdmin(admin2.userId)
  }, 120_000)

  afterAll(async () => {
    await testPrisma.featureFlag.updateMany({ where: { key: { in: ['kill.evidence-engine', 'kill.receipts-public'] } }, data: { enabled: false } })
    await cleanupTestUsers(suffix)
  }, 120_000)

  describe('the key set and health', () => {
    it('publishes the public keys to anybody, and nothing private', async () => {
      const res = await anon('/api/receipts/keys')
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toContain('public')
      const body = await res.json()
      expect(body.mode).toBe('fixture')
      expect(body.keys).toEqual([expect.objectContaining({ kty: 'OKP', crv: 'Ed25519', kid: FIXTURE_KID, alg: 'EdDSA', active: true })])
      expect(JSON.stringify(body)).not.toMatch(/"d"|PRIVATE KEY|MC4CAQ/)
    })

    it('reports how receipts are signed and how GitHub is reached, as modes only', async () => {
      const health = await (await anon('/api/health')).json()
      expect(health.evidence).toEqual({ signing: 'fixture', kid: FIXTURE_KID, github: 'anonymous' })
    })
  })

  describe('a sync, end to end', () => {
    let ada: TestUser
    let first: any

    beforeAll(async () => {
      ada = await person('ada', '6001')
      first = await sync(ada.userId)
    }, 120_000)

    it('reads the history into evidence, receipts and skill evidence, matched by GitHub id', async () => {
      expect(first).toMatchObject({ status: 'done', authMode: 'anonymous', stoppedBy: null })
      expect(first.repos).toBe(2)
      // Two repositories and one pull request merged upstream.
      expect(first.receipts).toBe(3)
      const repos = await testPrisma.githubRepoEvidence.findMany({ where: { userId: ada.userId }, orderBy: { fullName: 'asc' } })
      expect(repos.map((r) => [r.fullName, r.support, r.claimed])).toEqual([
        ['ada-gh/ancient', 'SUPPORTED', false],
        ['ada-gh/engine', 'SUPPORTED', false],
      ])
      const engine = repos.find((r) => r.fullName === 'ada-gh/engine')!
      expect(engine.strength).toBeGreaterThan(30)
      expect((engine.breakdown as any).reasons[0]).toMatch(/^Counts: 20 authored commits over 20 active days/)
      // The facts are minimal: nobody else's login, no email, no message.
      expect(JSON.stringify(engine.facts)).not.toMatch(/bob-gh|@|message/)
      const skillRows = await testPrisma.skillEvidence.findMany({ where: { userId: ada.userId, type: 'GITHUB_ACTIVITY' } })
      expect(skillRows.length).toBe(2)
      expect(skillRows.every((row) => row.skillId === skillId && row.support === 'SUPPORTED' && row.verifiedAt)).toBe(true)
      const state = await testPrisma.githubSyncState.findUniqueOrThrow({ where: { userId: ada.userId } })
      expect(state).toMatchObject({ status: 'DONE', authMode: 'anonymous' })
      expect(state.callsToday).toBeGreaterThan(0)
    })

    it('signs each receipt so that anybody can verify it offline with the public key alone', async () => {
      const receipt = await testPrisma.evidenceReceipt.findFirstOrThrow({ where: { userId: ada.userId, repoEvidence: { fullName: 'ada-gh/engine' } } })
      expect(receipt.id).toMatch(/^[0-9A-Za-z]{22}$/)
      expect(receipt.kid).toBe(FIXTURE_KID)
      const res = await anon(`/api/receipts/${receipt.id}`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.owner.username).toMatch(/^evada/)
      expect(body.receipt).toMatchObject({ id: receipt.id, status: 'VALID', signed: true })
      const keys = await (await anon('/api/receipts/keys')).json()
      const jwk = keys.keys.find((key: any) => key.kid === body.receipt.envelope.kid)
      const publicKey = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: 'jwk' })
      expect(verify(null, Buffer.from(canonicalize(body.receipt.envelope)), publicKey, Buffer.from(body.receipt.signature, 'base64url'))).toBe(true)
      // Changing one fact breaks it.
      const tampered = { ...body.receipt.envelope, facts: { ...body.receipt.envelope.facts, commits: { ...body.receipt.envelope.facts.commits, authored: 999 } } }
      expect(verify(null, Buffer.from(canonicalize(tampered)), publicKey, Buffer.from(body.receipt.signature, 'base64url'))).toBe(false)
    })

    it('answers with an ETag, and 304 when nothing changed', async () => {
      const receipt = await testPrisma.evidenceReceipt.findFirstOrThrow({ where: { userId: ada.userId } })
      const res = await anon(`/api/receipts/${receipt.id}`)
      const etag = res.headers.get('etag')!
      expect(etag).toMatch(/^"rc-/)
      expect(res.headers.get('cache-control')).toBe('public, max-age=300')
      expect((await anon(`/api/receipts/${receipt.id}`, { 'if-none-match': etag })).status).toBe(304)
    })

    it('grants Receipts, Upstream and the secret Archaeologist once, and no XP but theirs', async () => {
      const earned = await testPrisma.userAchievement.findMany({ where: { userId: ada.userId }, select: { achievement: { select: { slug: true } } } })
      expect(earned.map((row) => row.achievement.slug).sort()).toEqual(['archaeologist', 'receipts', 'upstream'])
      const xp = await testPrisma.xPEvent.findMany({ where: { userId: ada.userId } })
      expect(new Set(xp.map((row) => row.type))).toEqual(new Set(['ACHIEVEMENT_EARNED']))
      const expected = ACHIEVEMENT_DEFINITIONS.receipts.xpReward + ACHIEVEMENT_DEFINITIONS.upstream.xpReward + ACHIEVEMENT_DEFINITIONS.archaeologist.xpReward
      expect(xp.reduce((sum, row) => sum + row.amount, 0)).toBe(expected)
      expect((await testPrisma.user.findUniqueOrThrow({ where: { id: ada.userId } })).xp).toBe(expected)
    })

    it('is idempotent: running it again issues nothing new and pays nothing', async () => {
      const receiptsBefore = await testPrisma.evidenceReceipt.count({ where: { userId: ada.userId } })
      const again = await sync(ada.userId)
      expect(again).toMatchObject({ status: 'done', receipts: 3 })
      expect(await testPrisma.evidenceReceipt.count({ where: { userId: ada.userId } })).toBe(receiptsBefore)
      expect(await testPrisma.skillEvidence.count({ where: { userId: ada.userId, type: 'GITHUB_ACTIVITY' } })).toBe(2)
      expect(await testPrisma.xPEvent.count({ where: { userId: ada.userId } })).toBe(3)
    })

    it('shows the owner everything on GET /api/github, and the passport the proof and freshness', async () => {
      const overview = await req(ada.jar, 'GET', '/api/github')
      expect(overview.status).toBe(200)
      expect(overview.data).toMatchObject({ connected: true, visible: true, consent: { current: true }, sync: { status: 'DONE', authMode: 'anonymous' } })
      const engine = overview.data.repos.find((r: any) => r.fullName === 'ada-gh/engine')
      expect(engine).toMatchObject({ support: 'SUPPORTED', moderated: false, skills: ['nextjs', 'typescript'] })
      expect(engine.receipts[0]).toMatchObject({ status: 'VALID', signed: true })
      expect(overview.data.upstream).toEqual([expect.objectContaining({ fullName: 'bob-gh/lib', number: 5, status: 'VALID', signed: true })])
      expect(overview.data.suggestedSkills).toContain('nextjs')

      const viewer = await person('viewer', null, { consent: false })
      const passport = await req(viewer.jar, 'GET', `/api/users/${ada.userId}`)
      expect(passport.data.proof).toMatchObject({ visible: true, repos: 2, receipts: 3, upstream: 1 })
      expect(passport.data.proof.strongest[0].receiptId).toMatch(/^[0-9A-Za-z]{22}$/)
      const skills = await req(viewer.jar, 'GET', `/api/users/${ada.userId}/skills`)
      const ts = skills.data.find((row: any) => row.skillId === skillId)
      expect(ts.proof.strength).toBeGreaterThan(30)
      expect(ts.proof.receipts).toBeGreaterThanOrEqual(2)
      expect(ts.freshness.label).toMatch(/^(ACTIVE|WARM|RUSTY)$/)
      expect(ts.freshness.lastEvidencedAt).toBe('2025-04-08T10:00:00.000Z')
    })

    it('includes receipts and engine evidence in the data export', async () => {
      expect((await req(ada.jar, 'POST', '/api/users/me/export')).status).toBe(202)
      let latest: any
      for (let i = 0; i < 40; i++) {
        latest = await req(ada.jar, 'GET', '/api/users/me/export')
        if (latest.data.export?.status === 'READY') break
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      const download = await fetch(latest.data.export.downloadUrl, { headers: { authorization: `Bearer ${await ada.jar.token()}`, 'x-forwarded-for': ada.jar.ip } })
      const file = await download.json()
      expect(file.data.EvidenceReceipt).toHaveLength(3)
      expect(file.data.GithubRepoEvidence).toHaveLength(2)
      expect(file.data.GithubSyncState).toHaveLength(1)
    })
  })

  describe('co-authorship, unsupported claims and disputes', () => {
    let ada: TestUser
    let bob: TestUser
    let cara: TestUser
    let caraClaimId: string

    beforeAll(async () => {
      ada = await testPrisma.user.findFirstOrThrow({ where: { githubId: '6001' } }).then(async (row) => ({ userId: row.id, jar: null as never }))
      bob = await person('bob', '6002', { claims: ['https://github.com/ada-gh/engine'] })
      cara = await person('cara', '6003')
      expect((await req(cara.jar, 'POST', '/api/evidence', { skillId, type: 'GITHUB_PROJECT', title: 'My engine', url: 'https://github.com/ada-gh/engine' })).status).toBe(201)
      await sync(bob.userId)
      await sync(cara.userId)
      caraClaimId = (await testPrisma.githubRepoEvidence.findFirstOrThrow({ where: { userId: cara.userId, repoGithubId: '70001' } })).id
    }, 120_000)

    it('verifies collaborators from history, with each one’s share and the period both were active', async () => {
      const [a, b] = [ada.userId, bob.userId].sort()
      const pair = await testPrisma.verifiedCollaboration.findUniqueOrThrow({ where: { repoGithubId_userAId_userBId: { repoGithubId: '70001', userAId: a, userBId: b } } })
      const adaShare = a === ada.userId ? pair.shareA : pair.shareB
      const bobShare = a === bob.userId ? pair.shareA : pair.shareB
      expect([adaShare, bobShare]).toEqual([Math.round((20 / 26) * 1000) / 1000, Math.round((6 / 26) * 1000) / 1000])
      expect(pair.overlapStart?.toISOString()).toBe('2025-04-01T10:00:00.000Z')
      expect(pair.overlapEnd?.toISOString()).toBe('2025-04-08T10:00:00.000Z')
      expect(pair.receiptIds).toHaveLength(2)
      // Nobody without authored work is an edge.
      expect(await testPrisma.verifiedCollaboration.count({ where: { repoGithubId: '70001', OR: [{ userAId: cara.userId }, { userBId: cara.userId }] } })).toBe(0)
    })

    it('marks a claim with no authored work UNSUPPORTED, shows the owner why, and nobody else', async () => {
      const claim = await testPrisma.githubRepoEvidence.findUniqueOrThrow({ where: { id: caraClaimId } })
      expect(claim).toMatchObject({ claimed: true, support: 'UNSUPPORTED', strength: 0, supportReason: 'Claimed, not evidenced: no commits of yours in ada-gh/engine' })
      const own = await req(cara.jar, 'GET', '/api/evidence')
      const row = own.data.evidence.find((e: any) => e.type === 'GITHUB_PROJECT')
      expect(row).toMatchObject({ support: 'UNSUPPORTED', supportReason: 'Claimed, not evidenced: no commits of yours in ada-gh/engine' })
      const theirs = await req(bob.jar, 'GET', `/api/evidence?userId=${cara.userId}`)
      expect(theirs.data.evidence.find((e: any) => e.type === 'GITHUB_PROJECT')).toBeUndefined()
      // Never deleted.
      expect(await testPrisma.skillEvidence.count({ where: { userId: cara.userId, type: 'GITHUB_PROJECT' } })).toBe(1)
      expect((await req(bob.jar, 'GET', `/api/users/${cara.userId}`)).data.proof).toMatchObject({ visible: true, repos: 0 })
    })

    it('lets someone with work in the repository dispute the claim, into the queue, and nobody else', async () => {
      const overview = await req(bob.jar, 'GET', '/api/github')
      const engine = overview.data.repos.find((r: any) => r.repoGithubId === '70001')
      expect(engine.otherClaims).toEqual([expect.objectContaining({ id: caraClaimId, userId: cara.userId, support: 'UNSUPPORTED' })])
      // Cara has no work there, so she sees nobody's claim.
      expect((await req(cara.jar, 'GET', '/api/github')).data.repos[0].otherClaims).toEqual([])

      expect((await req(null, 'POST', `/api/github/repos/${caraClaimId}/dispute`, { description: 'She never committed here.' })).status).toBe(401)
      expect((await req(bob.jar, 'POST', `/api/github/repos/${caraClaimId}/dispute`, { description: 'short' })).status).toBe(400)
      expect((await req(bob.jar, 'POST', '/api/github/repos/nope/dispute', { description: 'There is nothing here at all.' })).data.error.code).toBe('CLAIM_NOT_FOUND')
      expect((await req(cara.jar, 'POST', `/api/github/repos/${caraClaimId}/dispute`, { description: 'Disputing my own claim here.' })).data.error.code).toBe('CANNOT_REPORT_SELF')
      const bobClaim = await testPrisma.githubRepoEvidence.findFirstOrThrow({ where: { userId: bob.userId, repoGithubId: '70001' } })
      expect((await req(cara.jar, 'POST', `/api/github/repos/${bobClaim.id}/dispute`, { description: 'I have no work there myself.' })).data.error.code).toBe('DISPUTE_NOT_ALLOWED')

      const filed = await req(bob.jar, 'POST', `/api/github/repos/${caraClaimId}/dispute`, { description: 'She never committed to this repository.' })
      expect(filed.status).toBe(201)
      expect(filed.data.report).toMatchObject({ status: 'PENDING' })
      expect((await req(bob.jar, 'POST', `/api/github/repos/${caraClaimId}/dispute`, { description: 'Again, she never committed here.' })).data.error.code).toBe('REPORT_ALREADY_PENDING')
      const queue = await req(admin.jar, 'GET', '/api/admin/queue?reason=CLAIM_DISPUTE&limit=50')
      expect(queue.data.items.map((item: any) => item.id)).toContain(filed.data.report.id)
      const report = await testPrisma.report.findUniqueOrThrow({ where: { id: filed.data.report.id } })
      expect(report).toMatchObject({ targetType: 'EVIDENCE_CLAIM', targetId: caraClaimId, reportedId: cara.userId, reason: 'CLAIM_DISPUTE' })
      expect(report.priority).toBeGreaterThanOrEqual(250)
    })

    it('takes the admin decision, audited and appealable, and an overturned appeal restores the claim', async () => {
      const report = await testPrisma.report.findFirstOrThrow({ where: { targetId: caraClaimId, reason: 'CLAIM_DISPUTE' } })
      const detail = await req(admin.jar, 'GET', `/api/admin/reports/${report.id}`)
      expect(detail.status).toBe(200)
      const acted = await req(admin.jar, 'POST', '/api/admin/actions', { action: 'HIDE_CONTENT', targetType: 'EVIDENCE_CLAIM', targetId: caraClaimId, reportId: report.id, category: 'CLAIM_DISPUTE', reason: 'The history shows no commits of hers' })
      expect(acted.status, JSON.stringify(acted.data)).toBe(201)
      expect((await testPrisma.githubRepoEvidence.findUniqueOrThrow({ where: { id: caraClaimId } })).moderatedAt).not.toBeNull()
      expect((await testPrisma.report.findUniqueOrThrow({ where: { id: report.id } })).status).toBe('RESOLVED')
      expect(await testPrisma.auditEvent.count({ where: { action: 'MODERATION_ACTION', targetType: 'EVIDENCE_CLAIM', targetId: caraClaimId } })).toBe(1)
      expect((await req(cara.jar, 'GET', '/api/github')).data.repos[0]).toMatchObject({ moderated: true, weight: 0 })

      const appeal = await req(cara.jar, 'POST', '/api/appeals', { actionId: acted.data.action.id, body: 'I pair-programmed on this with bob, look again.' })
      expect(appeal.status).toBe(201)
      const decided = await req(admin2.jar, 'POST', `/api/admin/appeals/${appeal.data.appeal.id}/decide`, { decision: 'OVERTURNED', note: 'Pairing is real work' })
      expect(decided.status).toBe(200)
      expect((await testPrisma.githubRepoEvidence.findUniqueOrThrow({ where: { id: caraClaimId } })).moderatedAt).toBeNull()
    })
  })

  describe('public receipt privacy', () => {
    const receiptOf = async (userId: string) => (await testPrisma.evidenceReceipt.findFirstOrThrow({ where: { userId }, orderBy: { capturedAt: 'desc' } })).id
    let dan: TestUser
    let danReceipt: string

    beforeAll(async () => {
      dan = await person('dan', '6004')
      await sync(dan.userId)
      danReceipt = await receiptOf(dan.userId)
    }, 120_000)

    it('shows a receipt of an adult with a public passport to anybody', async () => {
      expect((await anon(`/api/receipts/${danReceipt}`)).status).toBe(200)
    })

    it('answers 404 for an id that does not exist or is not one, alike', async () => {
      for (const id of ['0000000000000000000000', 'not-a-receipt', 'ckabcdefghijklmnopqrstu']) {
        const res = await anon(`/api/receipts/${id}`)
        expect(res.status, id).toBe(404)
        expect((await res.json()).error.code).toBe('RECEIPT_NOT_FOUND')
      }
    })

    it('answers 404 while the GitHub handle is not public, or the account is invisible', async () => {
      expect((await req(dan.jar, 'PATCH', '/api/users/me/privacy', { fieldVisibility: { githubUsername: 'PRIVATE' } })).status).toBe(200)
      expect((await anon(`/api/receipts/${danReceipt}`)).status).toBe(404)
      await req(dan.jar, 'PATCH', '/api/users/me/privacy', { fieldVisibility: { githubUsername: 'PUBLIC' }, invisibleMode: true })
      expect((await anon(`/api/receipts/${danReceipt}`)).status).toBe(404)
      await req(dan.jar, 'PATCH', '/api/users/me/privacy', { invisibleMode: false })
      expect((await anon(`/api/receipts/${danReceipt}`)).status).toBe(200)
    })

    it('applies the age policy: a minor, or an account with no date of birth, has no public receipts', async () => {
      const fay = await person('fay', '6006', { birthDate: bornYearsAgo(16) })
      await sync(fay.userId)
      const receipt = await receiptOf(fay.userId)
      expect((await anon(`/api/receipts/${receipt}`)).status).toBe(404)
      await testPrisma.user.update({ where: { id: fay.userId }, data: { birthDate: null } })
      expect((await anon(`/api/receipts/${receipt}`)).status).toBe(404)
      // The minor still sees their own evidence.
      expect((await req(fay.jar, 'GET', '/api/github')).data.repos).toHaveLength(1)
    })

    it('answers 410 for a revoked receipt, and 410 with the facts gone once the account is deleted', async () => {
      const gus = await person('gus', '6007')
      await sync(gus.userId)
      const receipt = await receiptOf(gus.userId)
      expect((await anon(`/api/receipts/${receipt}`)).status).toBe(200)
      expect((await req(gus.jar, 'DELETE', '/api/users/me')).status).toBe(200)
      const res = await anon(`/api/receipts/${receipt}`)
      expect(res.status).toBe(410)
      expect((await res.json()).error.code).toBe('RECEIPT_REVOKED')
      const row = await testPrisma.evidenceReceipt.findUniqueOrThrow({ where: { id: receipt } })
      expect(row).toMatchObject({ status: 'REVOKED', facts: {}, sourceUrl: '', signature: null })
      expect(await testPrisma.githubRepoEvidence.count({ where: { userId: gus.userId } })).toBe(0)
      expect(await testPrisma.skillEvidence.count({ where: { userId: gus.userId } })).toBe(0)
      expect((await testPrisma.user.findUniqueOrThrow({ where: { id: gus.userId } })).githubId).toBeNull()

      await testPrisma.evidenceReceipt.update({ where: { id: danReceipt }, data: { status: 'REVOKED', revokedAt: new Date() } })
      expect((await anon(`/api/receipts/${danReceipt}`)).status).toBe(410)
      await testPrisma.evidenceReceipt.update({ where: { id: danReceipt }, data: { status: 'VALID', revokedAt: null } })
    })

    it('is switched off by its kill switch, which leaves the key set up', async () => {
      await setKill('kill.receipts-public', true)
      try {
        const res = await anon(`/api/receipts/${danReceipt}`)
        expect(res.status).toBe(503)
        expect((await res.json()).error.code).toBe('RECEIPTS_PAUSED')
        expect((await anon('/api/receipts/keys')).status).toBe(200)
      } finally {
        await setKill('kill.receipts-public', false)
      }
      expect((await anon(`/api/receipts/${danReceipt}`)).status).toBe(200)
    })

    it('limits each address', async () => {
      const ip = syntheticIp()
      const statuses: number[] = []
      for (let i = 0; i < 61; i++) statuses.push((await anon(`/api/receipts/${danReceipt}`, { 'x-forwarded-for': ip })).status)
      expect(statuses.slice(0, 60).every((s) => s === 200 || s === 304)).toBe(true)
      expect(statuses[60]).toBe(429)
    })
  })

  describe('consent gating', () => {
    it('reads nothing without the consent, hides the evidence when it is withdrawn, and brings it back when it is given again', async () => {
      const eve = await person('eve', '6005', { consent: false })
      const viewer = await person('eviewer', null, { consent: false })
      expect(await sync(eve.userId)).toEqual({ status: 'no-consent' })
      expect(await testPrisma.githubRepoEvidence.count({ where: { userId: eve.userId } })).toBe(0)
      expect((await req(eve.jar, 'POST', '/api/github/sync')).data.error.code).toBe('GITHUB_SYNC_CONSENT_REQUIRED')

      // Giving it through the route queues a sync on the server; wait for it.
      expect((await req(eve.jar, 'POST', '/api/users/me/consents', { type: 'GITHUB_SYNC', version: versions.GITHUB_SYNC })).status).toBe(201)
      let state: any = null
      for (let i = 0; i < 60; i++) {
        state = await testPrisma.githubSyncState.findUnique({ where: { userId: eve.userId } })
        if (state?.status === 'DONE') break
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      expect(state?.status).toBe('DONE')
      const receipt = (await testPrisma.evidenceReceipt.findFirstOrThrow({ where: { userId: eve.userId } })).id
      expect((await req(viewer.jar, 'GET', `/api/users/${eve.userId}`)).data.proof.visible).toBe(true)
      expect((await anon(`/api/receipts/${receipt}`)).status).toBe(200)

      expect((await req(eve.jar, 'DELETE', '/api/users/me/consents/GITHUB_SYNC')).status).toBe(200)
      expect((await req(viewer.jar, 'GET', `/api/users/${eve.userId}`)).data.proof).toEqual({ visible: false, repos: 0, receipts: 0, upstream: 0, strongest: [] })
      expect((await req(viewer.jar, 'GET', `/api/evidence?userId=${eve.userId}`)).data.evidence.filter((e: any) => e.type === 'GITHUB_ACTIVITY')).toEqual([])
      const skills = await req(viewer.jar, 'GET', `/api/users/${eve.userId}/skills`)
      expect(skills.data[0].proof).toEqual({ strength: 0, weight: 0, repos: 0, receipts: 0 })
      expect(skills.data[0].freshness.lastEvidencedAt).toBeNull()
      expect((await anon(`/api/receipts/${receipt}`)).status).toBe(404)
      expect(await sync(eve.userId)).toEqual({ status: 'no-consent' })
      // Kept, not deleted.
      expect(await testPrisma.githubRepoEvidence.count({ where: { userId: eve.userId } })).toBe(1)

      expect((await req(eve.jar, 'POST', '/api/users/me/consents', { type: 'GITHUB_SYNC', version: versions.GITHUB_SYNC })).status).toBe(201)
      expect((await req(viewer.jar, 'GET', `/api/users/${eve.userId}`)).data.proof).toMatchObject({ visible: true, repos: 1 })
      expect((await anon(`/api/receipts/${receipt}`)).status).toBe(200)
    })
  })

  describe('identity and the strength heuristics, through the sync', () => {
    it('matches by id across a rename: the account’s login today finds its commits', async () => {
      const hal = await person('hal', '6008')
      expect(await sync(hal.userId)).toMatchObject({ status: 'done', repos: 1 })
      const repo = await testPrisma.githubRepoEvidence.findFirstOrThrow({ where: { userId: hal.userId } })
      expect(repo).toMatchObject({ fullName: 'hal-new/renamed', support: 'SUPPORTED' })
      expect((repo.facts as any).commits.authored).toBe(5)
      // Nobody else can hold the same GitHub id.
      const other = await person('halcopy', null)
      await expect(testPrisma.user.update({ where: { id: other.userId }, data: { githubId: '6008' } })).rejects.toThrow()
    })

    it('gives a claimed fork with no commits after the fork point nothing, and a one-night burst little', async () => {
      const ivy = await person('ivy', '6009', { claims: ['https://github.com/ivy-gh/fork'] })
      await sync(ivy.userId)
      const fork = await testPrisma.githubRepoEvidence.findFirstOrThrow({ where: { userId: ivy.userId } })
      expect(fork.strength).toBeLessThanOrEqual(2)
      expect((fork.breakdown as any).flags.forkWithoutWork).toBe(true)
      const jon = await person('jon', '6010')
      await sync(jon.userId)
      const burst = await testPrisma.githubRepoEvidence.findFirstOrThrow({ where: { userId: jon.userId } })
      expect((burst.facts as any).commits.authored).toBe(300)
      expect(burst.strength).toBeLessThan(15)
      expect((burst.breakdown as any).flags.burst).toBe(true)
    })
  })

  describe('the owner routes', () => {
    it('refuses anonymous callers', async () => {
      expect((await req(null, 'GET', '/api/github')).status).toBe(401)
      expect((await req(null, 'POST', '/api/github/sync')).status).toBe(401)
      expect((await req(null, 'POST', '/api/receipts/0000000000000000000000/recheck')).status).toBe(401)
    })

    it('debounces and limits manual syncs, and needs GitHub connected', async () => {
      const nobody = await person('nogh', null)
      expect((await req(nobody.jar, 'POST', '/api/github/sync')).data.error.code).toBe('GITHUB_NOT_CONNECTED')
      // A fixture account with no repositories, and a sync already running: the request joins it instead of queuing another.
      const kim = await person('kim', '6011')
      await testPrisma.githubSyncState.create({ data: { userId: kim.userId, status: 'RUNNING', requestedAt: new Date() } })
      const first = await req(kim.jar, 'POST', '/api/github/sync')
      expect(first.status).toBe(202)
      expect(first.data).toMatchObject({ queued: false, sync: { status: 'RUNNING' } })
      await req(kim.jar, 'POST', '/api/github/sync')
      await req(kim.jar, 'POST', '/api/github/sync')
      expect((await req(kim.jar, 'POST', '/api/github/sync')).status).toBe(429)
    })

    it('rechecks a receipt for its owner only, and lowers the weight of evidence whose source is gone', async () => {
      const ada = await testPrisma.user.findFirstOrThrow({ where: { githubId: '6001' } })
      const stranger = await person('stranger', null)
      const receipt = await testPrisma.evidenceReceipt.findFirstOrThrow({ where: { userId: ada.id, repoEvidenceId: { not: null } } })
      expect((await req(stranger.jar, 'POST', `/api/receipts/${receipt.id}/recheck`)).data.error.code).toBe('RECEIPT_NOT_FOUND')

      const owner = await person('ownr', null, { consent: false })
      const repo = await testPrisma.githubRepoEvidence.create({ data: { userId: owner.userId, repoGithubId: '79999', fullName: 'gone/away', url: 'https://github.com/gone/away', facts: { author: { githubId: '1' } }, strength: 40, syncedAt: new Date() } })
      const gone = await testPrisma.evidenceReceipt.create({ data: { id: 'GoneGoneGoneGoneGone01', userId: owner.userId, repoEvidenceId: repo.id, source: 'GITHUB', sourceRef: `repo:79999@commit:${'a'.repeat(40)}/facts:x`, sourceUrl: 'https://github.com/gone/away', capturedAt: new Date(), factsVersion: 1, facts: { author: { githubId: '1' } }, payloadHash: 'x' } })
      expect((await req(owner.jar, 'POST', `/api/receipts/${gone.id}/recheck`)).data.error.code).toBe('GITHUB_SYNC_CONSENT_REQUIRED')
      await testPrisma.consentRecord.create({ data: { userId: owner.userId, type: 'GITHUB_SYNC', version: versions.GITHUB_SYNC, source: 'api' } })
      const checked = await req(owner.jar, 'POST', `/api/receipts/${gone.id}/recheck`)
      expect(checked.status).toBe(200)
      expect(checked.data.receipt).toMatchObject({ id: gone.id, status: 'SOURCE_GONE', previousStatus: 'VALID' })
      expect((await testPrisma.githubRepoEvidence.findUniqueOrThrow({ where: { id: repo.id } })).sourceWeight).toBe(0.3)
      // Nothing was deleted.
      expect(await testPrisma.evidenceReceipt.count({ where: { id: gone.id } })).toBe(1)

      await testPrisma.evidenceReceipt.update({ where: { id: gone.id }, data: { status: 'REVOKED' } })
      expect((await req(owner.jar, 'POST', `/api/receipts/${gone.id}/recheck`)).data.error.code).toBe('RECEIPT_REVOKED')

      const nightly = await req(admin.jar, 'POST', '/api/admin/jobs/receipts/recheck')
      expect(nightly.status).toBe(200)
      expect(nightly.data.result.checked).toBeGreaterThan(0)
      const backlog = await req(admin.jar, 'POST', '/api/admin/jobs/receipts/sign-backlog')
      expect(backlog.data.result).toMatchObject({ mode: 'fixture' })
    })

    it('stops the engine under its kill switch: writes answer 503 and the jobs skip', async () => {
      const ada = await testPrisma.user.findFirstOrThrow({ where: { githubId: '6001' } })
      const mia = await person('mia', null)
      await setKill('kill.evidence-engine', true)
      try {
        expect((await req(mia.jar, 'POST', '/api/github/sync')).data.error.code).toBe('EVIDENCE_ENGINE_PAUSED')
        expect((await req(mia.jar, 'POST', '/api/github/repos/x/dispute', { description: 'Nothing to see here at all.' })).data.error.code).toBe('EVIDENCE_ENGINE_PAUSED')
        expect((await req(mia.jar, 'POST', '/api/receipts/0000000000000000000000/recheck')).data.error.code).toBe('EVIDENCE_ENGINE_PAUSED')
        expect((await req(mia.jar, 'GET', '/api/github')).status).toBe(200)
        expect(await sync(ada.id)).toEqual({ status: 'paused' })
        expect((await req(admin.jar, 'POST', '/api/admin/jobs/receipts/recheck')).data.result).toMatchObject({ stopped: 'paused' })
      } finally {
        await setKill('kill.evidence-engine', false)
      }
    })
  })
})

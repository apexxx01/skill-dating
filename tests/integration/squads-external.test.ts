import http from 'http'
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, promoteToAdmin, testPrisma } from './db'
import { INTEGRATION_DATABASE_URL, INTEGRATION_FIXTURE_PORT } from './config'
import { dropHackathons } from './squad-fixtures'

// External hackathons: a trusted user adds one by its link; the server reads the public page (a page this test serves; the server may fetch from
// this one private port and nothing else), deduplicates by the normalised link, refuses links the fetch safety rules refuse, never keeps the page's
// scripts, and creates it unverified (usable, flagged, paying nothing) until an admin verifies it.
describe('external hackathons', () => {
  const suffix = uniqueSuffix()
  const base = `http://localhost:${INTEGRATION_FIXTURE_PORT}`
  let server: http.Server
  let trusted: TestUser
  let fresh: TestUser
  let admin: TestUser
  const created: string[] = []

  const start = new Date(Date.now() + 20 * 24 * 3600_000)
  const end = new Date(Date.now() + 22 * 24 * 3600_000)
  const pages: Record<string, { type: string; body: string } | { redirect: string }> = {
    [`/hack-${suffix}`]: {
      type: 'text/html; charset=utf-8',
      body: `<!doctype html><html><head><title>ignored title</title>
        <meta property="og:image" content="/banner.png">
        <script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Hackathon', name: `Fixture Hack ${suffix}`, description: 'Build <b>things</b> <script>alert(1)</script>for good', startDate: start.toISOString(), endDate: end.toISOString(), eventAttendanceMode: 'https://schema.org/OnlineEventAttendanceMode' }).replace(/</g, '\\u003c')}</script>
        <script>window.evil = true</script></head><body>Hi</body></html>`,
    },
    [`/nodates-${suffix}`]: { type: 'text/html', body: `<html><head><meta property="og:title" content="Dateless ${suffix}"></head></html>` },
    [`/json-${suffix}`]: { type: 'application/json', body: '{}' },
    [`/away-${suffix}`]: { redirect: 'http://example.com/' },
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = INTEGRATION_DATABASE_URL
    server = http.createServer((request, response) => {
      const page = pages[(request.url ?? '').split('?')[0]]
      if (!page) return response.writeHead(404).end()
      if ('redirect' in page) return response.writeHead(302, { Location: page.redirect }).end()
      response.writeHead(200, { 'Content-Type': page.type }).end(page.body)
    })
    await new Promise<void>((resolve) => server.listen(INTEGRATION_FIXTURE_PORT, 'localhost', resolve))
    trusted = await registerAndLogin(`exu${suffix}@test.dev`, `exu${suffix}`)
    fresh = await registerAndLogin(`exf${suffix}@test.dev`, `exf${suffix}`, undefined, { fresh: true })
    admin = await registerAndLogin(`exa${suffix}@test.dev`, `exa${suffix}`)
    await promoteToAdmin(admin.userId)
  }, 120_000)
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
    await dropHackathons(created)
    await cleanupTestUsers(suffix)
  }, 120_000)

  const add = (who: TestUser, body: Record<string, unknown>) => req(who.jar, 'POST', '/api/hackathons/external', body)

  it('is for trusted accounts only', async () => {
    expect((await add(fresh, { url: `${base}/hack-${suffix}` })).data.error.code).toBe('ACCOUNT_NOT_TRUSTED')
  })

  it('refuses links the fetch rules refuse, and pages it cannot use', async () => {
    expect((await add(trusted, { url: 'ftp://example.com/hack' })).data.error.code).toBe('EXTERNAL_URL_REFUSED')
    expect((await add(trusted, { url: 'http://127.0.0.1:5432/' })).data.error.code).toBe('EXTERNAL_URL_REFUSED')
    expect((await add(trusted, { url: 'http://10.1.2.3/hack' })).data.error.code).toBe('EXTERNAL_URL_REFUSED')
    expect((await add(trusted, { url: 'http://user:pw@example.com/hack' })).data.error.code).toBe('EXTERNAL_URL_REFUSED')
    const away = await add(trusted, { url: `${base}/away-${suffix}` })
    expect(away.data.error.code).toBe('EXTERNAL_URL_REFUSED')
    expect(away.data.error.details).toEqual({ reason: 'redirect-off-host' })
    const json = await add(trusted, { url: `${base}/json-${suffix}` })
    expect(json.data.error.code).toBe('EXTERNAL_PAGE_UNREADABLE')
    expect(json.data.error.params).toEqual({ reason: 'not-html' })
    expect((await add(trusted, { url: `${base}/nodates-${suffix}` })).data.error.code).toBe('EXTERNAL_DATES_UNKNOWN')
  })

  it('creates an unverified hackathon from the page, without its scripts, and finds it again by any spelling of the link', async () => {
    const first = await add(trusted, { url: `${base}/hack-${suffix}?utm_source=newsletter`, tracks: [{ name: 'AI', description: 'Agents' }] })
    expect(first.status).toBe(201)
    const hackathon = first.data.hackathon
    created.push(hackathon.id)
    expect(first.data.created).toBe(true)
    expect(hackathon).toMatchObject({ name: `Fixture Hack ${suffix}`, source: 'EXTERNAL', platform: 'OTHER', status: 'UPCOMING', mode: 'ONLINE', unverified: true, verifiedAt: null, submittedById: trusted.userId })
    expect(hackathon.externalUrl).toBe(`https://localhost:${INTEGRATION_FIXTURE_PORT}/hack-${suffix}`)
    expect(hackathon.description).toBe('Build things for good')
    expect(JSON.stringify(hackathon)).not.toMatch(/<script|alert\(|window\.evil/i)
    expect(hackathon.banner).toBe(`${base}/banner.png`)
    expect(new Date(hackathon.startDate).toISOString()).toBe(start.toISOString())
    expect(hackathon.tracks).toEqual([{ name: 'AI', description: 'Agents' }])

    const again = await add(trusted, { url: `http://LOCALHOST:${INTEGRATION_FIXTURE_PORT}/hack-${suffix}/` })
    expect(again.status).toBe(200)
    expect(again.data).toMatchObject({ created: false, hackathon: { id: hackathon.id } })

    // Usable straight away (squads form for it), flagged everywhere, and paying nothing until it is verified.
    expect((await req(trusted.jar, 'GET', `/api/hackathons/${hackathon.id}`)).data.unverified).toBe(true)
    expect((await req(trusted.jar, 'POST', `/api/hackathons/${hackathon.id}`, {})).status).toBe(201)
    expect(await testPrisma.xPEvent.count({ where: { userId: trusted.userId, type: 'HACKATHON_JOIN', sourceId: hackathon.id } })).toBe(0)
    expect((await req(trusted.jar, 'POST', '/api/teams', { name: `External Team ${suffix}`, hackathonId: hackathon.id })).status).toBe(201)

    // Only an admin verifies it.
    expect((await req(trusted.jar, 'PATCH', `/api/admin/hackathons/${hackathon.id}/verify`, { verified: true })).status).toBe(403)
    const verified = await req(admin.jar, 'PATCH', `/api/admin/hackathons/${hackathon.id}/verify`, { verified: true })
    expect(verified.data).toMatchObject({ id: hackathon.id, unverified: false })
    expect((await req(trusted.jar, 'GET', `/api/hackathons/${hackathon.id}`)).data.unverified).toBe(false)
  })

  it('takes the dates from the caller when the page has none', async () => {
    const made = await add(trusted, { url: `${base}/nodates-${suffix}`, startDate: start.toISOString(), endDate: end.toISOString() })
    expect(made.status).toBe(201)
    created.push(made.data.hackathon.id)
    expect(made.data.hackathon).toMatchObject({ name: `Dateless ${suffix}`, unverified: true })
  })
})

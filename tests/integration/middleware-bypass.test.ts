import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { INTEGRATION_BASE_URL } from './config'
import { syntheticIp } from './helpers'

// CVE-2025-29927: on affected Next.js versions a client can send
// `x-middleware-subrequest` and the framework skips middleware for that request.
// Whatever the framework does with that header, an anonymous visitor must never
// get further than they would without it. Every page and API route under
// src/app is discovered from the file system, so a route added later is covered
// without anyone remembering to list it.

const APP_DIR = path.resolve(__dirname, '../../src/app')

// Both spellings of the middleware module name (with and without the src/ prefix),
// repeated past the recursion limit older and newer releases check against.
const BYPASS_HEADERS = [
  'src/middleware:src/middleware:src/middleware:src/middleware:src/middleware',
  'middleware:middleware:middleware:middleware:middleware',
]

const PUBLIC_PAGES = new Set(['/', '/signin', '/signup', '/error'])
// Answer anonymous callers on purpose; asserted individually below. The webhook
// and the Inngest route authenticate by request signature instead of a session.
const PUBLIC_API_ROUTES = new Set(['/api/auth/session', '/api/webhooks/clerk', '/api/inngest'])
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? walk(full) : [full]
  })
}

function toUrlPath(file: string): string {
  const segments = path
    .relative(APP_DIR, path.dirname(file))
    .split(path.sep)
    .filter((segment) => segment && !/^\(.*\)$/.test(segment))
    .map((segment) => (/^\[.*\]$/.test(segment) ? 'x' : segment))
  return '/' + segments.join('/')
}

function exportedMethods(file: string): string[] {
  const source = fs.readFileSync(file, 'utf-8')
  return METHODS.filter((method) =>
    new RegExp(`export\\s+(async\\s+)?function\\s+${method}\\b|export\\s+const\\s+${method}\\b`).test(source)
  )
}

const files = walk(APP_DIR)
const pages = files.filter((f) => /[\\/]page\.tsx$/.test(f)).map(toUrlPath)
const apiRoutes = files
  .filter((f) => /[\\/]route\.ts$/.test(f))
  .flatMap((f) => exportedMethods(f).map((method) => ({ method, path: toUrlPath(f) })))

interface Observed {
  status: number
  location: string
  body: string
}

async function call(method: string, urlPath: string, bypass?: string): Promise<Observed> {
  const headers: Record<string, string> = { 'x-forwarded-for': syntheticIp() }
  if (bypass) headers['x-middleware-subrequest'] = bypass
  const hasBody = method !== 'GET'
  if (hasBody) headers['content-type'] = 'application/json'
  const res = await fetch(INTEGRATION_BASE_URL + urlPath, {
    method,
    redirect: 'manual',
    headers,
    body: hasBody ? '{}' : undefined,
  })
  return { status: res.status, location: res.headers.get('location') ?? '', body: await res.text() }
}

const isRedirect = (status: number) => [301, 302, 303, 307, 308].includes(status)

// Bounded parallelism, used only for requests to routes that are already compiled.
// `next dev` compiles a route on its first request, and several first requests to
// dynamic-segment routes at once can make the dev server read a manifest file
// while another compile is still writing it ("Unexpected end of JSON input" from
// inside next/dist, a 500 before any of our code runs). So every route is
// requested once, one at a time, before anything is sent in parallel.
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++
        results[index] = await fn(items[index])
      }
    })
  )
  return results
}

describe('route discovery', () => {
  it('finds the pages and API routes it is supposed to guard', () => {
    expect(pages).toContain('/dashboard')
    expect(pages).toContain('/onboarding')
    expect(apiRoutes.length).toBeGreaterThan(50)
    expect(apiRoutes).toContainEqual({ method: 'GET', path: '/api/users/me' })
  })
})

describe('x-middleware-subrequest (CVE-2025-29927)', () => {
  it('never lets an anonymous visitor into a page', async () => {
    const guarded = pages.filter((p) => !PUBLIC_PAGES.has(p))
    const failures: string[] = []

    const controls = new Map<string, Observed>()
    for (const pagePath of guarded) controls.set(pagePath, await call('GET', pagePath)) // compiles each page

    await mapLimit(guarded, 6, async (pagePath) => {
      const control = controls.get(pagePath)!
      if (!isRedirect(control.status) || !control.location.includes('/signin')) {
        failures.push(`${pagePath}: without the header an anonymous visitor got ${control.status} ${control.location}`)
        return
      }
      for (const bypass of BYPASS_HEADERS) {
        const attempt = await call('GET', pagePath, bypass)
        if (attempt.status !== control.status || !attempt.location.includes('/signin')) {
          failures.push(`${pagePath}: header "${bypass.slice(0, 24)}..." changed ${control.status} ${control.location} into ${attempt.status} ${attempt.location}`)
        }
      }
    })

    expect(failures).toEqual([])
  }, 300_000)

  it('rejects an anonymous call to every API route with the header', async () => {
    const guarded = apiRoutes.filter((r) => !PUBLIC_API_ROUTES.has(r.path))
    const failures: string[] = []

    const controls = new Map<string, Observed>()
    for (const { method, path: routePath } of guarded) controls.set(`${method} ${routePath}`, await call(method, routePath)) // compiles each route

    await mapLimit(guarded, 6, async ({ method, path: routePath }) => {
      const control = controls.get(`${method} ${routePath}`)!
      if (control.status !== 401) {
        failures.push(`${method} ${routePath}: without the header an anonymous call got ${control.status}`)
        return
      }
      for (const bypass of BYPASS_HEADERS) {
        const attempt = await call(method, routePath, bypass)
        if (attempt.status !== 401) {
          failures.push(`${method} ${routePath}: header "${bypass.slice(0, 24)}..." turned 401 into ${attempt.status}`)
        }
      }
    })

    expect(failures).toEqual([])
  }, 600_000)

  it('leaves the deliberately public routes behaving the same with the header', async () => {
    for (const bypass of [undefined, ...BYPASS_HEADERS]) {
      const session = await call('GET', '/api/auth/session', bypass)
      expect(session.status).toBe(200)
      expect(JSON.parse(session.body)).toBeNull()

      // The webhook's only credential is its signature: unsigned is refused either way.
      const webhook = await call('POST', '/api/webhooks/clerk', bypass)
      expect([400, 503]).toContain(webhook.status)
    }

    // The Inngest route checks the request signature itself. Whatever it answers,
    // the header must not change it.
    for (const method of ['GET', 'POST', 'PUT']) {
      const control = await call(method, '/api/inngest')
      for (const bypass of BYPASS_HEADERS) {
        const attempt = await call(method, '/api/inngest', bypass)
        expect(attempt.status, `${method} /api/inngest`).toBe(control.status)
      }
    }
  }, 60_000)
})

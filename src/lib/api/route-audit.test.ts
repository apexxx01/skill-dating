import { describe, it, expect } from 'vitest'
import { auditAllRoutes, perMinute } from './route-audit'
import { PUBLIC_ROUTES, RATE_LIMIT_CEILINGS, routeClass } from './rate-limit-classes'

// The authorization audit, over every API route in the tree (found from the file system, so a route added later is covered without anyone listing
// it): each handler either goes through withAuth, which verifies the session and the account before anything else runs, or is on the explicit public
// allowlist; admin routes require a role; and every authenticated route has a rate limit within its class's ceiling. The same rules are exercised
// against the running server by tests/integration/route-authz.test.ts.

const routes = auditAllRoutes()
const describeRoute = (r: { method: string; path: string }) => `${r.method} ${r.path}`

describe('route audit', () => {
  it('finds the routes it is meant to check', () => {
    expect(routes.length).toBeGreaterThan(150)
    expect(routes.map(describeRoute)).toContain('GET /api/users/me')
  })

  it('wraps every handler in withAuth, apart from the explicit public allowlist', () => {
    const unwrapped = routes.filter((r) => !r.wrapped).map((r) => r.path)
    expect([...new Set(unwrapped)].sort()).toEqual([...PUBLIC_ROUTES].sort())
  })

  it('keeps the public allowlist exactly as small as it is documented', () => {
    expect([...PUBLIC_ROUTES].sort()).toEqual([
      '/api/auth/session',
      '/api/health',
      '/api/inngest',
      '/api/invites/check',
      '/api/notifications/open/[token]',
      '/api/notifications/unsubscribe',
      '/api/og/achievement/[slug]',
      '/api/og/link',
      '/api/og/passport/[username]',
      '/api/og/post/[id]',
      '/api/og/squad/[id]',
      '/api/webhooks/clerk',
      '/api/webhooks/email',
    ])
  })

  it('requires a staff role on every admin route', () => {
    const admin = routes.filter((r) => r.path.startsWith('/api/admin/'))
    expect(admin.length).toBeGreaterThan(10)
    const open = admin.filter((r) => !r.requiredRole || r.requiredRole.length === 0 || r.requiredRole.some((role) => !['ADMIN', 'MODERATOR'].includes(role)))
    expect(open.map(describeRoute)).toEqual([])
  })

  it('gives every authenticated route a rate limit within its class ceiling', () => {
    const problems: string[] = []
    for (const route of routes) {
      const cls = routeClass(route.path, route.method)
      if (cls === 'PUBLIC') continue
      if (!route.rateLimit) {
        problems.push(`${describeRoute(route)}: no rate limit`)
        continue
      }
      const { windowMs, maxRequests, keyPrefix } = route.rateLimit
      if (!Number.isFinite(windowMs) || !Number.isFinite(maxRequests) || !keyPrefix) problems.push(`${describeRoute(route)}: rate limit is not a literal`)
      else if (perMinute(route.rateLimit) > RATE_LIMIT_CEILINGS[cls]) problems.push(`${describeRoute(route)}: ${perMinute(route.rateLimit)}/min is above the ${cls} ceiling of ${RATE_LIMIT_CEILINGS[cls]}`)
    }
    expect(problems).toEqual([])
  })

  it('gives each rate limit its own key, so two routes never share a bucket by accident', () => {
    const byKey = new Map<string, string[]>()
    for (const route of routes) {
      if (!route.rateLimit?.keyPrefix) continue
      byKey.set(route.rateLimit.keyPrefix, [...(byKey.get(route.rateLimit.keyPrefix) ?? []), describeRoute(route)])
    }
    const shared = [...byKey].filter(([, users]) => new Set(users.map((u) => u.split(' ')[1])).size > 1)
    expect(shared).toEqual([])
  })
})

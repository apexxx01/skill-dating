// Rate limits by route class: the most a route of each class may allow, per caller, per minute. Each route sets its own limit with
// `withAuth(..., { rateLimit })`; the route audit test (route-audit.test.ts) fails when one is missing or above its class's ceiling. The table and the
// reasoning are in docs/SECURITY.md ("Rate limits").
//
// Limits are keyed on the local user id (it cannot be forged or shared), and on the client address before sign-in. Besides the per-route limits:
//   - every anonymous API call: 120 a minute per address (src/lib/api/handler.ts);
//   - first sight of a Clerk account (the local row is created or linked): 10 a minute per account (src/lib/session.ts);
//   - new accounts: SIGNUP_LIMIT per address (src/lib/identity/signup.ts);
//   - a HIGH risk account: RISK_WRITE_LIMIT on every write, on top of the route's own (src/lib/api/handler.ts).

export type RouteClass = 'PUBLIC' | 'ADMIN' | 'SEARCH' | 'READ' | 'WRITE' | 'TOGGLE'

/** Requests a minute, per caller. */
export const RATE_LIMIT_CEILINGS: Record<Exclude<RouteClass, 'PUBLIC'>, number> = {
  ADMIN: 60,
  SEARCH: 60,
  READ: 120,
  WRITE: 60,
  TOGGLE: 120,
}

/** Answer anybody: authenticated by request signature (the webhooks, Inngest, the signed links in emails) or public by design (health, the session probe). */
export const PUBLIC_ROUTES = new Set([
  '/api/auth/session',
  '/api/health',
  '/api/inngest',
  '/api/webhooks/clerk',
  // Reach and retention (docs/NOTIFICATIONS.md). The email provider's bounces, signed; the links in emails, signed.
  '/api/webhooks/email',
  '/api/notifications/unsubscribe',
  '/api/notifications/open/[token]',
  // Share cards: public images, rate limited by address and cached.
  '/api/og/passport/[username]',
  '/api/og/post/[id]',
  '/api/og/squad/[id]',
  '/api/og/achievement/[slug]',
])

/** Lists and searches over many people or things: the most expensive reads, and what a scraper would use. */
export const SEARCH_ROUTES = new Set(['/api/users', '/api/discover', '/api/projects', '/api/teams', '/api/builds', '/api/hackathons', '/api/leaderboard', '/api/search'])

/** Small writes a person makes many times in a row while using a screen (marking a conversation read, ticking a checklist, voting on an idea). */
export const TOGGLE_ROUTES = new Set([
  'POST /api/conversations/[id]/read',
  'PATCH /api/teams/[id]/checklist/[itemId]',
  'POST /api/teams/[id]/ideas/[ideaId]/vote',
  'DELETE /api/teams/[id]/ideas/[ideaId]/vote',
])

export function routeClass(path: string, method: string): RouteClass {
  if (PUBLIC_ROUTES.has(path)) return 'PUBLIC'
  if (path === '/api/admin' || path.startsWith('/api/admin/')) return 'ADMIN'
  if (TOGGLE_ROUTES.has(`${method} ${path}`)) return 'TOGGLE'
  if (method === 'GET') return SEARCH_ROUTES.has(path) ? 'SEARCH' : 'READ'
  return 'WRITE'
}

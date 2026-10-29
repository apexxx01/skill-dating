import type { KillSwitch } from '@/lib/ops/kill-switches'
import type { RestrictedFeature } from '@/lib/moderation/restrictions'

// Which feature a request uses, for the request gate (gate.ts): the kill switches and moderation's feature restrictions are applied centrally, from
// the method and the path, so no route can forget them. Pure. Reading is never refused here; only what writes to a feature is (and, for the romance
// mode, everything but leaving it).

type Feature = Extract<KillSwitch, RestrictedFeature | 'external_hackathons' | 'evidence_engine'>

const SEG = '[^/]+'
const RULES: { feature: Feature; methods: readonly string[]; pattern: RegExp }[] = [
  // Messaging: starting a conversation, sending, editing and reacting.
  { feature: 'messaging', methods: ['POST'], pattern: new RegExp(`^/api/conversations(/${SEG})?$`) },
  { feature: 'messaging', methods: ['PATCH', 'PUT'], pattern: new RegExp(`^/api/messages/${SEG}$`) },
  { feature: 'messaging', methods: ['POST'], pattern: new RegExp(`^/api/messages/${SEG}/reactions$`) },
  // Posting: the Ship Feed, comments, looking-for-group posts, squad ideas and demos.
  { feature: 'posting', methods: ['POST'], pattern: /^\/api\/posts$/ },
  { feature: 'posting', methods: ['PATCH', 'PUT'], pattern: new RegExp(`^/api/posts/${SEG}$`) },
  { feature: 'posting', methods: ['POST'], pattern: new RegExp(`^/api/posts/${SEG}/comments$`) },
  { feature: 'posting', methods: ['PATCH', 'PUT'], pattern: new RegExp(`^/api/comments/${SEG}$`) },
  { feature: 'posting', methods: ['POST'], pattern: new RegExp(`^/api/hackathons/${SEG}/lfg$`) },
  { feature: 'posting', methods: ['PATCH', 'PUT'], pattern: new RegExp(`^/api/hackathons/${SEG}/lfg/${SEG}$`) },
  { feature: 'posting', methods: ['POST'], pattern: new RegExp(`^/api/teams/${SEG}/(ideas|demo-post)$`) },
  // External hackathon submissions.
  { feature: 'external_hackathons', methods: ['POST'], pattern: /^\/api\/hackathons\/external$/ },
  // The evidence engine: a sync, a recheck, a dispute (docs/PROOF.md). Reading what it found stays open.
  { feature: 'evidence_engine', methods: ['POST'], pattern: /^\/api\/github\/sync$/ },
  { feature: 'evidence_engine', methods: ['POST'], pattern: new RegExp(`^/api/github/repos/${SEG}/dispute$`) },
  { feature: 'evidence_engine', methods: ['POST'], pattern: new RegExp(`^/api/receipts/${SEG}/recheck$`) },
]

export function featureOfRequest(method: string, pathname: string): Feature | null {
  const path = pathname.replace(/\/+$/, '')
  // The romance mode: every route of it, except leaving it (which must always work) and asking to be told when it opens (which works while it is closed: that is what it is for).
  if (path === '/api/romance/interest') return null
  if (path === '/api/romance' || path.startsWith('/api/romance/')) return method === 'DELETE' && path === '/api/romance/profile' ? null : 'romance'
  for (const rule of RULES) if (rule.methods.includes(method) && rule.pattern.test(path)) return rule.feature
  return null
}

/** What a suspended or banned person can still do: see who they are and what happened, appeal, read their notices, export their data, delete the account, and consent. */
export function closedAccountAllows(method: string, pathname: string): boolean {
  const path = pathname.replace(/\/+$/, '')
  if (method === 'GET' && ['/api/users/me', '/api/users/me/profile', '/api/auth/session', '/api/users/me/moderation', '/api/notifications', '/api/users/me/consents', '/api/users/me/privacy'].includes(path)) return true
  if (path === '/api/appeals' && (method === 'GET' || method === 'POST')) return true
  if (path === '/api/users/me/export' || path.startsWith('/api/users/me/export/')) return true
  if (path === '/api/users/me' && method === 'DELETE') return true
  if (path === '/api/users/me/consents' && method === 'POST') return true
  return false
}

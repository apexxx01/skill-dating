import { NextRequest } from 'next/server'
import { withAuth, createApiResponse, createApiError } from '@/lib/api/handler'
import { engineEvidenceVisible, requestGithubSync } from '@/lib/evidence/sync'

// POST /api/github/sync: read the caller's public GitHub history again now (src/lib/evidence/sync.ts). Debounced: while a sync queued or started in the last
// ten minutes is pending, this answers with it and queues nothing (`queued: false`). Needs a connected GitHub account (409 GITHUB_NOT_CONNECTED) and the
// GITHUB_SYNC consent (403 GITHUB_SYNC_CONSENT_REQUIRED). 503 EVIDENCE_ENGINE_PAUSED under the kill switch. Three every ten minutes.
export const POST = withAuth(async (_request: NextRequest, { prisma, user }) => {
  const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { githubId: true } })
  if (!row.githubId) return createApiError('GITHUB_NOT_CONNECTED')
  if (!(await engineEvidenceVisible(prisma, user.id))) return createApiError('GITHUB_SYNC_CONSENT_REQUIRED')
  const { queued } = await requestGithubSync(prisma, user.id, 'manual')
  const state = await prisma.githubSyncState.findUniqueOrThrow({ where: { userId: user.id } })
  return createApiResponse({ queued, sync: { status: state.status, requestedAt: state.requestedAt?.toISOString() ?? null, lastSyncedAt: state.lastSyncedAt?.toISOString() ?? null } }, 202)
}, { rateLimit: { windowMs: 600000, maxRequests: 3, keyPrefix: 'github:sync' } })

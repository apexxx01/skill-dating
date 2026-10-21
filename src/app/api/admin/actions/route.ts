import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { actionSchema, applyModerationAction, DESTRUCTIVE_ACTIONS } from '@/lib/moderation/actions'
import { requireRecentAuth } from '@/lib/api/recent-auth'

// POST /api/admin/actions: a moderator acts on a person or on something they made (src/lib/moderation/actions.ts): WARN, HIDE_CONTENT, REMOVE_CONTENT,
// RESTRICT_FEATURE (romance, messaging or posting, for N days), SUSPEND (N days), BAN, APPROVE_MEDIA. Each has a reason category and a note for the
// record, an optional note to the person, resolves the open reports about the same thing, is audited, and tells the person. A ban and a removal need a
// session signed in within the last 10 minutes (403 REAUTH_REQUIRED). Only an admin acts on a staff account. Staff only.
export const POST = withAuth(async (request: NextRequest, { prisma, user, session }) => {
  const body = await validateBody(actionSchema)(request)
  if (body instanceof Response) return body
  if (DESTRUCTIVE_ACTIONS.includes(body.data.action)) {
    const reauth = await requireRecentAuth(session)
    if (reauth) return reauth
  }
  const result = await applyModerationAction(prisma, user, body.data)
  if (!result.ok) return createApiError(result.code, result.params ? { params: result.params } : undefined)
  return createApiResponse({ action: result.action }, 201)
}, { requiredRole: ['ADMIN', 'MODERATOR'], idempotent: true, rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'admin:actions' } })

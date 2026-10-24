import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { CODE_TTL_MINUTES, startVerification } from '@/lib/campus/campus'
import { EmailSendError } from '@/lib/infra/email'
import { log } from '@/lib/log'
import { bodySchema } from './schema'

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const body = await validateBody(bodySchema)(request)
  if (body instanceof Response) return body
  try {
    const outcome = await startVerification(prisma, user.id, body.data)
    if (outcome.ok) return createApiResponse({ sent: true, domain: outcome.domain, expiresAt: outcome.expiresAt, expiresInMinutes: CODE_TTL_MINUTES })
    if (outcome.code === 'CAMPUS_EMAIL_INVALID') return createApiError('CAMPUS_EMAIL_INVALID', { params: { domains: (outcome.domains ?? []).join(', ') } })
    return createApiError(outcome.code)
  } catch (error) {
    if (error instanceof EmailSendError) {
      log.warn('could not send a campus verification code', { error: error.message, userId: user.id })
      return createApiError('SERVICE_UNAVAILABLE')
    }
    throw error
  }
}, { rateLimit: { windowMs: 3_600_000, maxRequests: 5, keyPrefix: 'campus:verify-start' } })

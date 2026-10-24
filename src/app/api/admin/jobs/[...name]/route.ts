import { NextRequest } from 'next/server'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { withAuth, createApiResponse, createApiError, readBodyText } from '@/lib/api/handler'
import { jobs, runJob } from '@/lib/infra/jobs'
import { bodySchema } from './schema'

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const name = new URL(request.url).pathname.replace(/^\/api\/admin\/jobs\//, '').replace(/\/+$/, '')
  if (!Object.prototype.hasOwnProperty.call(jobs, name)) return createApiError('JOB_NOT_FOUND')

  // No body at all means "run it with its defaults".
  const raw = await readBodyText(request)
  if (raw instanceof Response) return raw
  let payload: unknown = {}
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw)
    } catch {
      return createApiError('INVALID_JSON')
    }
  }
  const body = bodySchema.safeParse(payload)
  if (!body.success) return createApiError('VALIDATION_FAILED', { details: body.error.flatten().fieldErrors })

  const started = Date.now()
  let result: unknown
  try {
    result = await runJob(jobs, name, body.data.data ?? {})
  } catch (error) {
    // A payload the job's own schema refuses is the caller's mistake, not a failure of the job.
    if (error instanceof z.ZodError) return createApiError('VALIDATION_FAILED', { details: error.flatten().fieldErrors })
    throw error
  }
  const durationMs = Date.now() - started

  await prisma.auditEvent.create({
    data: { userId: user.id, action: 'JOB_RUN', targetType: 'JOB', targetId: name, newValue: { durationMs } as Prisma.InputJsonValue },
  })
  return createApiResponse({ name, durationMs, result })
}, { requiredRole: ['ADMIN'], rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'admin:jobs-run' } })

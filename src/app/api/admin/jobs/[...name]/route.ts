import { NextRequest } from 'next/server'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { withAuth, createApiResponse, createApiError, readBodyText } from '@/lib/api/handler'
import { jobs, runJob } from '@/lib/infra/jobs'
import { boundedJson } from '@/lib/api/limits'

// POST /api/admin/jobs/{area}/{action}  body: { data?: {...} }
//
// Admin only. Runs one of the background jobs (src/lib/infra/jobs.ts) right now, in this request, and
// answers with what it returned: how an operator triggers the nightly leaderboard rebuild or the
// season rollover outside their schedule, and how a deploy without the job queue (a preview, a
// laptop) runs them. The job runs exactly as the queue would run it, payload validated by its schema.
const bodySchema = z.object({ data: boundedJson(16_384).optional() })

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

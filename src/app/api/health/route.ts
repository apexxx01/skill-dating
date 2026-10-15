import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCache } from '@/lib/infra/cache'
import { getJobQueue } from '@/lib/infra/jobs'
import { getRealtime } from '@/lib/infra/realtime'
import { healthStatusCode, runHealthChecks } from '@/lib/health'
import { clientIp, consumeSafely, tooManyRequests } from '@/lib/rate-limiter'
import { log, requestIdFrom, runWithRequestId } from '@/lib/log'

// Public, for uptime monitors and load balancers: no session, no secrets in the
// answer (see src/lib/health.ts). A monitor polls it every few seconds at most, so
// the limit is generous and only stops it being used to hammer the database.
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const requestId = requestIdFrom(request.headers)
  return runWithRequestId(requestId, async () => {
    const decision = await consumeSafely(`health:ip:${clientIp(request) ?? 'untrusted'}`, { windowMs: 60_000, maxRequests: 300 })
    if (!decision.allowed) return tooManyRequests(decision)

    const report = await runHealthChecks({
      pingDatabase: async () => {
        await prisma.$queryRaw`SELECT 1`
      },
      cache: getCache,
      jobs: getJobQueue,
      realtime: getRealtime,
    })
    if (report.status !== 'ok') log.warn('health check not ok', { status: report.status, checks: report.checks })

    return NextResponse.json(report, {
      status: healthStatusCode(report),
      headers: { 'Cache-Control': 'no-store', 'X-Request-Id': requestId },
    })
  })
}

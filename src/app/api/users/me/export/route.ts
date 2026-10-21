import { NextRequest } from 'next/server'
import { withAuth, createApiResponse, createApiError } from '@/lib/api/handler'
import { getJobQueue } from '@/lib/infra/jobs'
import { getStorage } from '@/lib/infra/storage'
import { requestExport } from '@/lib/privacy/export'

// The data export (docs/PRIVACY.md). POST asks for a new one: a job builds a JSON file of everything held about the caller, and they are notified when it
// is ready (202; an export already being prepared is returned as it is). GET returns the latest export: its status and, once READY, a signed download
// link that lasts until the file expires 24 hours after it was made (410 EXPORT_EXPIRED after that). Both work for a suspended or banned account.

async function view(request: NextRequest, row: { id: string; status: string; storageKey: string | null; bytes: number | null; createdAt: Date; completedAt: Date | null; expiresAt: Date | null }) {
  const live = row.status === 'READY' && row.storageKey && row.expiresAt && row.expiresAt.getTime() > Date.now()
  const ttlSeconds = live ? Math.max(1, Math.floor((row.expiresAt!.getTime() - Date.now()) / 1000)) : 0
  return {
    id: row.id,
    status: row.status === 'READY' && !live ? 'EXPIRED' : row.status,
    bytes: row.bytes,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
    expiresAt: row.expiresAt,
    downloadUrl: live ? await getStorage().signedReadUrl(row.storageKey!, ttlSeconds, new URL(request.url).origin) : null,
  }
}

export const GET = withAuth(async (request: NextRequest, { prisma, user }) => {
  const latest = await prisma.dataExport.findFirst({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } })
  if (!latest) return createApiError('EXPORT_NOT_FOUND')
  const shown = await view(request, latest)
  if (shown.status === 'EXPIRED') return createApiError('EXPORT_EXPIRED')
  return createApiResponse({ export: shown })
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'users:me:export-get' } })

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const { export: row, created } = await requestExport(prisma, user.id)
  if (created) {
    await getJobQueue().enqueue('privacy/export', { exportId: row.id }, { id: `export:${row.id}` })
    await prisma.auditEvent.create({ data: { userId: user.id, action: 'DATA_EXPORT_REQUESTED', targetType: 'DATA_EXPORT', targetId: row.id } })
  }
  return createApiResponse({ export: await view(request, row) }, 202)
}, { idempotent: true, rateLimit: { windowMs: 24 * 60 * 60 * 1000, maxRequests: 5, keyPrefix: 'users:me:export-create' } })

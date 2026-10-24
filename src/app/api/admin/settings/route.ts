import { withAuth, createApiResponse } from '@/lib/api/handler'
import { listSettings } from '@/lib/settings'

// Admin only. The values an administrator can change without a deploy, each with its default and whether it has been changed (src/lib/settings.ts).
export const GET = withAuth(async (_request, { prisma }) => {
  return createApiResponse({ settings: await listSettings(prisma) })
}, { requiredRole: ['ADMIN'], rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'admin:settings-list' } })

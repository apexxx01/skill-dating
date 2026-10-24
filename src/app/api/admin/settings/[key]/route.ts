import { NextRequest } from 'next/server'
import { Prisma } from '@prisma/client'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { isSettingKey, settingView, SETTINGS } from '@/lib/settings'
import { updateSettingSchema } from './schema'

const keyFrom = (request: NextRequest): string | null => {
  const key = decodeURIComponent(new URL(request.url).pathname.split('/').pop() ?? '')
  return isSettingKey(key) ? key : null
}

// Admin only. Sets the value of a known setting; the old and the new value go to the audit log.
export const PUT = withAuth(async (request: NextRequest, { prisma, user }) => {
  const key = keyFrom(request)
  if (!key) return createApiError('SETTING_NOT_FOUND')

  const body = await validateBody(updateSettingSchema)(request)
  if (body instanceof Response) return body
  const parsed = SETTINGS[key].schema.safeParse(body.data.value)
  if (!parsed.success) return createApiError('VALIDATION_FAILED', { details: { value: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'value'}: ${issue.message}`) } })

  const before = await settingView(prisma, key)
  await prisma.platformSetting.upsert({
    where: { key },
    create: { key, value: parsed.data as Prisma.InputJsonValue, updatedById: user.id },
    update: { value: parsed.data as Prisma.InputJsonValue, updatedById: user.id },
  })
  const after = await settingView(prisma, key)

  await prisma.auditEvent.create({
    data: {
      userId: user.id,
      action: 'PLATFORM_SETTING_UPDATED',
      targetType: 'PLATFORM_SETTING',
      targetId: key,
      oldValue: { value: before.value } as unknown as Prisma.InputJsonValue,
      newValue: { value: after.value } as unknown as Prisma.InputJsonValue,
    },
  })
  return createApiResponse(after)
}, { requiredRole: ['ADMIN'], rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'admin:settings-update' } })

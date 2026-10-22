import { NextRequest } from 'next/server'
import { z } from 'zod'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'

// PATCH /api/admin/invites/{id}: change a campaign code's label, limit or expiry, or switch it off (`disabled: true`) or on again. A personal code can only be switched off or on.
const patchSchema = z
  .object({
    label: z.string().trim().min(2).max(100),
    maxUses: z.number().int().min(1).max(1_000_000).nullable(),
    expiresAt: z.string().datetime().nullable(),
    disabled: z.boolean(),
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Send at least one field')

export const PATCH = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = new URL(request.url).pathname.split('/').pop() ?? ''
  const body = await validateBody(patchSchema)(request)
  if (body instanceof Response) return body
  const code = await prisma.inviteCode.findUnique({ where: { id } })
  if (!code) return createApiError('INVITE_NOT_FOUND')
  if (code.kind === 'PERSONAL' && (body.data.label !== undefined || body.data.maxUses !== undefined || body.data.expiresAt !== undefined)) {
    return createApiError('VALIDATION_FAILED', { details: { disabled: ['A personal code can only be switched off or on'] } })
  }
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.inviteCode.update({
      where: { id },
      data: {
        ...(body.data.label !== undefined ? { label: body.data.label } : {}),
        ...(body.data.maxUses !== undefined ? { maxUses: body.data.maxUses } : {}),
        ...(body.data.expiresAt !== undefined ? { expiresAt: body.data.expiresAt === null ? null : new Date(body.data.expiresAt) } : {}),
        ...(body.data.disabled !== undefined ? { disabledAt: body.data.disabled ? code.disabledAt ?? new Date() : null } : {}),
      },
    })
    await tx.auditEvent.create({ data: { userId: user.id, action: 'INVITE_CODE_UPDATED', targetType: 'INVITE', targetId: id, oldValue: { label: code.label, maxUses: code.maxUses, disabled: code.disabledAt !== null }, newValue: { label: row.label, maxUses: row.maxUses, disabled: row.disabledAt !== null } } })
    return row
  })
  return createApiResponse({ code: updated })
}, { requiredRole: ['ADMIN'], rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'admin:invites-patch' } })

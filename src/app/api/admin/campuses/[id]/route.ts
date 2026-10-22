import { NextRequest } from 'next/server'
import { z } from 'zod'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { campusColumns } from '@/lib/campus/campus'

// PATCH /api/admin/campuses/{id}: rename, change the domains or the place, or close the campus to new members (`disabled: true`; the people it has keep their place).
// The slug never changes: it is the key of the campus leaderboard and of everyone's place on it.
const patchSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    emailDomains: z.array(z.string().trim().max(253)).min(1).max(20),
    city: z.string().max(100).nullable(),
    countryCode: z.string().max(2).nullable(),
    disabled: z.boolean(),
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Send at least one field')

export const PATCH = withAuth(async (request: NextRequest, { prisma, user }) => {
  const id = new URL(request.url).pathname.split('/').pop() ?? ''
  const body = await validateBody(patchSchema)(request)
  if (body instanceof Response) return body
  const campus = await prisma.campus.findUnique({ where: { id } })
  if (!campus) return createApiError('CAMPUS_NOT_FOUND')
  const columns = campusColumns(body.data)
  if (!columns.ok) return createApiError('VALIDATION_FAILED', { details: { [columns.field]: [columns.message] } })
  const data = { ...columns.data, ...(body.data.disabled === undefined ? {} : { disabledAt: body.data.disabled ? campus.disabledAt ?? new Date() : null }) }
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.campus.update({ where: { id }, data })
    await tx.auditEvent.create({ data: { userId: user.id, action: 'CAMPUS_UPDATED', targetType: 'CAMPUS', targetId: id, oldValue: { name: campus.name, emailDomains: campus.emailDomains, disabled: campus.disabledAt !== null }, newValue: { name: row.name, emailDomains: row.emailDomains, disabled: row.disabledAt !== null } } })
    return row
  })
  return createApiResponse({ campus: updated })
}, { requiredRole: ['ADMIN'], rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'admin:campuses-patch' } })

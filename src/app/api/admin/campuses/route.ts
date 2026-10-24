import { NextRequest } from 'next/server'
import { withAuth, validateBody, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { campusColumns, campusSlug } from '@/lib/campus/campus'
import { createSchema, listSchema } from './schema'

export const GET = withAuth(async (request: NextRequest, { prisma }) => {
  const query = validateQuery(listSchema)(request)
  if (query instanceof Response) return query
  const { q, includeDisabled, limit, cursor } = query.data
  const rows = await prisma.campus.findMany({
    where: { ...(includeDisabled === 'true' ? {} : { disabledAt: null }), ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { slug: { contains: q.toLowerCase() } }] } : {}) },
    orderBy: { id: 'asc' },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: { _count: { select: { memberships: true } } },
  })
  const page = rows.slice(0, limit)
  return createApiResponse({
    campuses: page.map(({ _count, ...campus }) => ({ ...campus, members: _count.memberships })),
    nextCursor: rows.length > limit ? page[page.length - 1].id : null,
  })
}, { requiredRole: ['ADMIN'], rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'admin:campuses-list' } })

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const body = await validateBody(createSchema)(request)
  if (body instanceof Response) return body
  const columns = campusColumns(body.data)
  if (!columns.ok) return createApiError('VALIDATION_FAILED', { details: { [columns.field]: [columns.message] } })
  const slug = campusSlug(body.data.slug ?? body.data.name)
  if (!slug) return createApiError('VALIDATION_FAILED', { details: { slug: ['Letters, digits and hyphens'] } })
  if (await prisma.campus.findUnique({ where: { slug }, select: { id: true } })) return createApiError('CAMPUS_SLUG_TAKEN')
  const campus = await prisma.$transaction(async (tx) => {
    const created = await tx.campus.create({ data: { slug, name: columns.data.name!, emailDomains: columns.data.emailDomains!, city: columns.data.city ?? null, cityKey: columns.data.cityKey ?? null, countryCode: columns.data.countryCode ?? null, createdById: user.id } })
    await tx.auditEvent.create({ data: { userId: user.id, action: 'CAMPUS_CREATED', targetType: 'CAMPUS', targetId: created.id, newValue: { slug, name: created.name, emailDomains: created.emailDomains } } })
    return created
  })
  return createApiResponse({ campus }, 201)
}, { requiredRole: ['ADMIN'], rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'admin:campuses-create' } })

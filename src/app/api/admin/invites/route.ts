import { NextRequest } from 'next/server'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { withAuth, validateBody, validateQuery, createApiResponse, createApiError } from '@/lib/api/handler'
import { generateCode, normalizeCode } from '@/lib/invites/codes'

// Campaign invite codes, made by admins for a launch waitlist or a partner college (docs/INVITES.md): attribution only, no XP. GET lists them with how they are doing.
const createSchema = z
  .object({
    label: z.string().trim().min(2).max(100),
    // Left out: a random one. Given: 4 to 32 letters and digits ("IISC2026").
    code: z.string().trim().max(40).optional(),
    campusId: z.string().max(64).optional(),
    maxUses: z.number().int().min(1).max(1_000_000).optional(),
    expiresAt: z.string().datetime().optional(),
  })
  .strict()

const listSchema = z.object({ kind: z.enum(['PERSONAL', 'CAMPAIGN']).default('CAMPAIGN'), limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().max(64).optional() })

export const GET = withAuth(async (request: NextRequest, { prisma }) => {
  const query = validateQuery(listSchema)(request)
  if (query instanceof Response) return query
  const { kind, limit, cursor } = query.data
  const rows = await prisma.inviteCode.findMany({
    where: { kind },
    orderBy: { id: 'asc' },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: { campus: { select: { id: true, slug: true, name: true } } },
  })
  const page = rows.slice(0, limit)
  const grouped = await prisma.inviteRedemption.groupBy({ by: ['codeId', 'status'], where: { codeId: { in: page.map((row) => row.id) } }, _count: { _all: true } })
  const statusCount = (codeId: string, ...statuses: string[]) => grouped.filter((row) => row.codeId === codeId && statuses.includes(row.status)).reduce((sum, row) => sum + row._count._all, 0)
  return createApiResponse({
    codes: page.map((row) => ({
      id: row.id,
      code: row.code,
      kind: row.kind,
      label: row.label,
      campus: row.campus,
      maxUses: row.maxUses,
      uses: row.uses,
      qualified: statusCount(row.id, 'QUALIFIED', 'REWARDED'),
      rejected: statusCount(row.id, 'REJECTED'),
      expiresAt: row.expiresAt,
      disabledAt: row.disabledAt,
      createdAt: row.createdAt,
    })),
    nextCursor: rows.length > limit ? page[page.length - 1].id : null,
  })
}, { requiredRole: ['ADMIN'], rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'admin:invites-list' } })

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const body = await validateBody(createSchema)(request)
  if (body instanceof Response) return body
  const text = body.data.code === undefined ? generateCode() : normalizeCode(body.data.code)
  if (!text) return createApiError('VALIDATION_FAILED', { details: { code: ['4 to 32 letters and digits'] } })
  if (body.data.campusId && !(await prisma.campus.findUnique({ where: { id: body.data.campusId }, select: { id: true } }))) return createApiError('CAMPUS_NOT_FOUND')
  try {
    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.inviteCode.create({
        data: { code: text, kind: 'CAMPAIGN', label: body.data.label, campusId: body.data.campusId ?? null, maxUses: body.data.maxUses ?? null, expiresAt: body.data.expiresAt ? new Date(body.data.expiresAt) : null, createdById: user.id },
      })
      await tx.auditEvent.create({ data: { userId: user.id, action: 'INVITE_CODE_CREATED', targetType: 'INVITE', targetId: row.id, newValue: { label: row.label, maxUses: row.maxUses, campusId: row.campusId } } })
      return row
    })
    return createApiResponse({ code: created }, 201)
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return createApiError('INVITE_CODE_TAKEN')
    throw error
  }
}, { requiredRole: ['ADMIN'], rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'admin:invites-create' } })

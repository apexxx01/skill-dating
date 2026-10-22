import { NextRequest } from 'next/server'
import { withAuth, createApiResponse } from '@/lib/api/handler'
import { isMinor } from '@/lib/age-policy'
import { leaveCampus } from '@/lib/campus/campus'
import { refreshBoards } from '@/lib/campus/boards'

// The caller's campus: the one they verified, a verification in progress, and the campus an invite suggested. The campus e-mail address is never part of it.
export const GET = withAuth(async (_request: NextRequest, { prisma, user }) => {
  const [membership, pending, redemption, account] = await Promise.all([
    prisma.campusMembership.findUnique({ where: { userId: user.id }, select: { verifiedAt: true, campus: { select: { id: true, slug: true, name: true, city: true, countryCode: true } } } }),
    prisma.campusVerification.findUnique({ where: { userId: user.id }, select: { campusId: true, email: true, expiresAt: true } }),
    prisma.inviteRedemption.findUnique({ where: { inviteeId: user.id }, select: { code: { select: { campus: { select: { id: true, slug: true, name: true, disabledAt: true } } } } } }),
    prisma.user.findUnique({ where: { id: user.id }, select: { birthDate: true } }),
  ])
  const suggested = redemption?.code.campus && !redemption.code.campus.disabledAt && redemption.code.campus.id !== membership?.campus.id ? { id: redemption.code.campus.id, slug: redemption.code.campus.slug, name: redemption.code.campus.name } : null
  return createApiResponse({
    campus: membership?.campus ?? null,
    verifiedAt: membership?.verifiedAt ?? null,
    pending: pending && pending.expiresAt.getTime() > Date.now() ? { campusId: pending.campusId, domain: pending.email ? pending.email.slice(pending.email.lastIndexOf('@') + 1) : null, expiresAt: pending.expiresAt } : null,
    suggested,
    // A minor, or an account with no date of birth yet, shares a country and nothing finer.
    canJoin: Boolean(account?.birthDate) && !isMinor(account?.birthDate),
  })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'campus:me' } })

export const DELETE = withAuth(async (_request: NextRequest, { prisma, user }) => {
  const { left, previous } = await leaveCampus(prisma, user.id)
  if (left) await refreshBoards(user.id, previous)
  return createApiResponse({ success: true, left })
}, { rateLimit: { windowMs: 60000, maxRequests: 10, keyPrefix: 'campus:leave' } })

import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { getStorage } from '@/lib/infra/storage'
import { romanceProfileSchema } from '@/lib/romance/profile'
import { leaveRomance } from '@/lib/romance/lifecycle'
import { loadOwnRomance, saveRomanceProfile } from '@/lib/romance/service'
import { track } from '@/lib/infra/analytics'

// The caller's own romance profile (the mode's name, in `modeLabel`, comes from one constant: src/lib/romance/config.ts). It is opt-in and 18+: the gate is the
// one for DATING (a date of birth that makes them 18 or older, a verified email, and a verified phone or a connected GitHub account).
//
//   GET     { modeLabel, exists, profile, photos, eligibility, options }. `profile.private` (gender, who they are interested in, the age range, the scope, the inbox gate) is
//           returned to the owner and to nobody else, anywhere. `options` is the vocabulary of the form.
//   PUT     saves the whole profile (what is left out takes its default). Joining the mode is the first PUT.
//   DELETE  leaves the mode: the profile, its photos, its drops and pending sparks are removed and open romance matches are ended (silently, for good).
export const GET = withAuth(async (_request: NextRequest, { prisma, user }) => {
  return createApiResponse(await loadOwnRomance(prisma, getStorage(), user.id))
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'romance:profile-get' } })

export const PUT = withAuth(async (request: NextRequest, { prisma, user }) => {
  const body = await validateBody(romanceProfileSchema)(request)
  if (body instanceof Response) return body

  const existed = (await prisma.romanceProfile.count({ where: { userId: user.id } })) > 0
  const saved = await saveRomanceProfile(prisma, user.id, body.data)
  if (!saved.ok) return createApiError(saved.code, { details: saved.details })
  if (!existed) await track(user.id, 'romance_joined')
  return createApiResponse(await loadOwnRomance(prisma, getStorage(), user.id), existed ? 200 : 201)
}, { rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'romance:profile-put' } })

export const DELETE = withAuth(async (_request: NextRequest, { prisma, user }) => {
  const removal = await leaveRomance(prisma, getStorage(), user.id)
  if (removal.hadProfile) await track(user.id, 'romance_left')
  return createApiResponse({ left: true, hadProfile: removal.hadProfile, matchesEnded: removal.matchesEnded })
}, { rateLimit: { windowMs: 60000, maxRequests: 10, keyPrefix: 'romance:profile-delete' } })

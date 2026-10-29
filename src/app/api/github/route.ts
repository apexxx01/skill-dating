import { NextRequest } from 'next/server'
import { withAuth, createApiResponse } from '@/lib/api/handler'
import { githubOverview } from '@/lib/evidence/overview'

// GET /api/github: the caller's connected evidence (src/lib/evidence/overview.ts): whether GitHub is connected and the GITHUB_SYNC consent given, the last
// sync and the day's call budget, every repository with its strength and reasons, its support (an UNSUPPORTED claim says why), its receipts and verified
// collaborators, other people's claims to it (only where the caller has authored work), the pull requests merged upstream, and suggested skills.
export const GET = withAuth(async (_request: NextRequest, { prisma, user }) => {
  return createApiResponse(await githubOverview(prisma, user.id))
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'github:overview' } })

import { NextRequest } from 'next/server'
import { withAuth, createApiResponse } from '@/lib/api/handler'
import { quizForClient } from '@/lib/matching/quiz'

// The working-style quiz: a short, fixed set of questions, in code. Answers go in PUT /api/matching/profile (workingStyle).
export const GET = withAuth(async (_request: NextRequest) => {
  return createApiResponse(quizForClient())
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'matching:quiz' } })

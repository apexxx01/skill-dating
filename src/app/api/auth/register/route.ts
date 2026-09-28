import { NextRequest } from 'next/server'
import { hash } from 'bcryptjs'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { rateLimit, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'

const registerSchema = z.object({
  name: z.string().min(1).max(100),
  username: z
    .string()
    .min(3)
    .max(30)
    .regex(/^[a-zA-Z0-9_-]+$/, 'Username may only contain letters, numbers, hyphens, and underscores'),
  email: z.string().email(),
  password: z.string().min(8).max(200),
})

const registerRateLimit = rateLimit({ windowMs: 60000, maxRequests: 10, keyPrefix: 'auth:register' })

export async function POST(request: NextRequest) {
  const rateLimitResponse = await registerRateLimit(request)
  if (rateLimitResponse) return rateLimitResponse

  const bodyResult = await validateBody(registerSchema)(request)
  if (bodyResult instanceof Response) return bodyResult

  const { name, username, email, password } = bodyResult.data

  const [existingEmail, existingUsername] = await Promise.all([
    prisma.user.findUnique({ where: { email }, select: { id: true } }),
    prisma.user.findUnique({ where: { username }, select: { id: true } }),
  ])

  if (existingEmail) {
    return createApiError('An account with this email already exists', 409)
  }
  if (existingUsername) {
    return createApiError('That username is taken', 409)
  }

  const passwordHash = await hash(password, 12)

  const user = await prisma.user.create({
    data: { name, username, email, passwordHash },
    select: { id: true, name: true, username: true, email: true },
  })

  await prisma.auditEvent.create({
    data: {
      userId: user.id,
      action: 'USER_CREATED',
      targetType: 'USER',
      targetId: user.id,
    },
  })

  return createApiResponse(user, 201)
}

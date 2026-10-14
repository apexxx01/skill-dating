import { PrismaClient } from '@prisma/client'
import { nodeEnv } from '@/lib/env'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  log: nodeEnv === 'development' ? ['query', 'error', 'warn'] : ['error'],
})

if (nodeEnv !== 'production') globalForPrisma.prisma = prisma

export default prisma
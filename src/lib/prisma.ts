import { PrismaClient } from '@prisma/client'
import { nodeEnv } from '@/lib/env'
import { withUtcSession } from '@/lib/database-url'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

// Read here and not through `env`: the client is created when the module loads, before (and without needing)
// the rest of the configuration. Prisma reads the same variable for the schema's datasource.
const databaseUrl = process.env.DATABASE_URL

export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  // Every connection runs in UTC (src/lib/database-url.ts).
  ...(databaseUrl ? { datasourceUrl: withUtcSession(databaseUrl) } : {}),
  log: nodeEnv === 'development' ? ['query', 'error', 'warn'] : ['error'],
})

if (nodeEnv !== 'production') globalForPrisma.prisma = prisma

export default prisma

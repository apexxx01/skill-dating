import { PrismaClient } from '@prisma/client'

// A direct Prisma client against the same disposable integration database
// the test server itself uses - for setup/teardown and assertions the HTTP
// API has no route for (e.g. promoting a user to ADMIN, or checking a raw
// row count to prove idempotency rather than trusting a response body).
export const testPrisma = new PrismaClient({
  datasources: {
    db: { url: 'postgresql://postgres:postgres@localhost:5432/skill_dating_integration?schema=public' },
  },
})

export async function promoteToAdmin(userId: string) {
  await testPrisma.user.update({ where: { id: userId }, data: { role: 'ADMIN' } })
}

export async function cleanupTestUsers(emailContains: string) {
  await testPrisma.user.deleteMany({ where: { email: { contains: emailContains } } })
}

import { PrismaClient } from '@prisma/client'
import { INTEGRATION_DATABASE_URL } from './config'
import { deleteRegisteredUsers } from './clerk-api'

// A direct Prisma client against the same disposable integration database
// the test server itself uses - for setup/teardown and assertions the HTTP
// API has no route for (e.g. promoting a user to ADMIN, or checking a raw
// row count to prove idempotency rather than trusting a response body).
export const testPrisma = new PrismaClient({
  datasources: {
    db: { url: INTEGRATION_DATABASE_URL },
  },
})

export async function promoteToAdmin(userId: string) {
  await testPrisma.user.update({ where: { id: userId }, data: { role: 'ADMIN' } })
}

// Removes the local rows and the Clerk users this file created (matched by email
// marker), so a run never accumulates users on the shared development instance.
export async function cleanupTestUsers(emailContains: string) {
  await testPrisma.user.deleteMany({ where: { email: { contains: emailContains } } })
  await deleteRegisteredUsers(emailContains)
}

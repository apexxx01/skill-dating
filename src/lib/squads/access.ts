import type { PrismaClient, Prisma } from '@prisma/client'
import type { AuthenticatedUser } from '@/lib/api/handler'

// Who may do what on a team, as the existing team routes already decide it: the team's OWNER or ADMIN members manage it (and a platform admin may
// always), and its members see its private space.

type Db = PrismaClient | Prisma.TransactionClient

export async function teamRoleOf(db: Db, userId: string, teamId: string): Promise<'OWNER' | 'ADMIN' | 'MEMBER' | null> {
  const membership = await db.teamMember.findUnique({ where: { userId_teamId: { userId, teamId } }, select: { role: true } })
  return membership?.role ?? null
}

export async function canManageTeam(db: Db, user: Pick<AuthenticatedUser, 'id' | 'role'>, teamId: string): Promise<boolean> {
  if (user.role === 'ADMIN') return true
  const role = await teamRoleOf(db, user.id, teamId)
  return role === 'OWNER' || role === 'ADMIN'
}

export async function isTeamMember(db: Db, user: Pick<AuthenticatedUser, 'id' | 'role'>, teamId: string, options: { adminToo?: boolean } = {}): Promise<boolean> {
  if (options.adminToo && user.role === 'ADMIN') return true
  return (await teamRoleOf(db, user.id, teamId)) !== null
}

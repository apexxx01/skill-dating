import type { NextRequest } from 'next/server'
import type { Prisma, PrismaClient } from '@prisma/client'
import { grantAchievement } from '@/lib/achievements'
import type { AchievementSlug } from '@/lib/achievement-definitions'

// Ids in these routes come straight out of the URL path. Anything that is not
// a plausible id is treated as "no such row" without touching the database.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export function isValidId(id: string | undefined): id is string {
  return typeof id === 'string' && ID_PATTERN.test(id)
}

// /api/projects/{projectId}/{updates|milestones}/{childId}
export function projectIdFromPath(request: NextRequest): string | undefined {
  return new URL(request.url).pathname.split('/')[3]
}

export function childIdFromPath(request: NextRequest): string | undefined {
  return new URL(request.url).pathname.split('/')[5]
}

export interface ProjectAccess {
  project: { id: string; name: string; slug: string; ownerId: string; isPublic: boolean }
  isOwner: boolean
  isMember: boolean
  isAdmin: boolean
  canRead: boolean
}

// Reads follow the same rule as GET /api/projects/[id]: a public project is
// visible to any signed-in user, a private one only to its owner and members.
// Writes require membership (the owner always has a ProjectMember row, but is
// treated as a member regardless).
export async function loadProjectAccess(
  prisma: PrismaClient,
  projectId: string,
  user: { id: string; role: string }
): Promise<ProjectAccess | null> {
  if (!isValidId(projectId)) return null

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, slug: true, ownerId: true, isPublic: true },
  })
  if (!project) return null

  const membership = await prisma.projectMember.findUnique({
    where: { userId_projectId: { userId: user.id, projectId } },
    select: { id: true },
  })

  const isOwner = project.ownerId === user.id
  const isMember = isOwner || Boolean(membership)
  return { project, isOwner, isMember, isAdmin: user.role === 'ADMIN', canRead: project.isPublic || isMember }
}

// Transaction-scoped advisory lock: concurrent transactions asking for the
// same key run one after another, released automatically on commit/rollback.
export async function advisoryLock(tx: Prisma.TransactionClient, key: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
}

// grantAchievement is idempotent for sequential calls but is a check-then-
// insert, so two transactions granting the same slug at once (the very first
// grant of an achievement, or one user completing two milestones in parallel)
// can both pass the check and one then fails on the unique constraint,
// aborting its whole transaction. Serialising the grant per slug removes that.
export async function grantAchievementSerialized(
  tx: Prisma.TransactionClient,
  userId: string,
  slug: AchievementSlug
): Promise<{ granted: boolean }> {
  await advisoryLock(tx, `achievement:${slug}`)
  return grantAchievement(tx, userId, slug)
}

export const authorSelect = { id: true, name: true, username: true, image: true } as const

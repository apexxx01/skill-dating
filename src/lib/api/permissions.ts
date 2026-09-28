// Pure permission checks, deliberately kept free of any Next.js/next-auth
// import so they're unit-testable with a mocked Prisma client outside the
// Next runtime. `handler.ts` re-exports these for existing route imports.
import type { prisma as PrismaClient } from '@/lib/prisma'

export async function checkOwnership(
  prisma: typeof PrismaClient,
  userId: string,
  resourceType: string,
  resourceId: string
): Promise<boolean> {
  switch (resourceType) {
    case 'project': {
      const project = await prisma.project.findUnique({
        where: { id: resourceId },
        select: { ownerId: true }
      })
      return project?.ownerId === userId
    }
    case 'team': {
      const team = await prisma.team.findUnique({
        where: { id: resourceId },
        select: { ownerId: true }
      })
      return team?.ownerId === userId
    }
    case 'message': {
      const message = await prisma.message.findUnique({
        where: { id: resourceId },
        select: { senderId: true }
      })
      return message?.senderId === userId
    }
    case 'connection': {
      const connection = await prisma.connection.findUnique({
        where: { id: resourceId },
        select: { senderId: true, receiverId: true }
      })
      return connection?.senderId === userId || connection?.receiverId === userId
    }
    default:
      return false
  }
}

export async function checkMembership(
  prisma: typeof PrismaClient,
  userId: string,
  resourceType: string,
  resourceId: string
): Promise<boolean> {
  switch (resourceType) {
    case 'project': {
      const member = await prisma.projectMember.findUnique({
        where: { userId_projectId: { userId, projectId: resourceId } }
      })
      return !!member
    }
    case 'team': {
      const member = await prisma.teamMember.findUnique({
        where: { userId_teamId: { userId, teamId: resourceId } }
      })
      return !!member
    }
    case 'conversation': {
      const member = await prisma.conversationMember.findUnique({
        where: { userId_conversationId: { userId, conversationId: resourceId } }
      })
      return !!member
    }
    case 'hackathon': {
      const participant = await prisma.hackathonParticipant.findUnique({
        where: { userId_hackathonId: { userId, hackathonId: resourceId } }
      })
      return !!participant
    }
    default:
      return false
  }
}

export async function authorize(
  prisma: typeof PrismaClient,
  userId: string,
  userRole: string,
  action: 'read' | 'write' | 'delete' | 'admin',
  resourceType: string,
  resourceId: string
): Promise<boolean> {
  if (userRole === 'ADMIN') return true
  if (userRole === 'MODERATOR' && action !== 'delete') return true

  const isOwner = await checkOwnership(prisma, userId, resourceType, resourceId)
  if (isOwner) return true

  const isMember = await checkMembership(prisma, userId, resourceType, resourceId)
  if (!isMember) return false

  if (action === 'read') return true
  if (action === 'write') return true
  if (action === 'delete') return false

  return false
}

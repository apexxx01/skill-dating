import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError, checkMembership } from '@/lib/api/handler'
import { z } from 'zod'
import { awardXp } from '@/lib/xp'

const registerTeamSchema = z.object({
  teamId: z.string(),
  projectId: z.string().optional(),
})

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').slice(-2)[0]

  if (!id) {
    return createApiError('Hackathon ID required', 400)
  }

  const hackathon = await prisma.hackathon.findUnique({ where: { id } })
  if (!hackathon) {
    return createApiError('Hackathon not found', 404)
  }

  if (hackathon.status !== 'UPCOMING' && hackathon.status !== 'ACTIVE') {
    return createApiError('Team registration closed', 400)
  }

  const participant = await prisma.hackathonParticipant.findUnique({
    where: { userId_hackathonId: { userId: user.id, hackathonId: id } }
  })
  if (!participant) {
    return createApiError('Must register for hackathon first', 400)
  }

  if (participant.teamId) {
    return createApiError('Already in a team for this hackathon', 400)
  }

  const bodyResult = await validateBody(registerTeamSchema)(request)
  if (bodyResult instanceof Response) return bodyResult

  const team = await prisma.team.findUnique({
    where: { id: bodyResult.data.teamId },
    include: { members: true }
  })

  if (!team) {
    return createApiError('Team not found', 404)
  }

  if (team.hackathonId && team.hackathonId !== id) {
    return createApiError('Team belongs to different hackathon', 400)
  }

  if (team.members.length >= (team.maxSize || 5)) {
    return createApiError('Team is full', 400)
  }

  const isMember = team.members.some((m: { userId: string }) => m.userId === user.id)
  const isOwner = team.ownerId === user.id

  if (!isMember && !isOwner) {
    const application = await prisma.teamApplication.findUnique({
      where: { userId_teamId: { userId: user.id, teamId: team.id } }
    })
    if (!application || application.status !== 'ACCEPTED') {
      return createApiError('Not a team member', 403)
    }
  }

  if (bodyResult.data.projectId) {
    const project = await prisma.project.findUnique({ where: { id: bodyResult.data.projectId } })
    if (!project || project.ownerId !== user.id) {
      return createApiError('Project not found or not owned by you', 404)
    }
  }

  // Any team member can call this (isMember/isOwner check above), so the
  // HackathonTeam row may already exist from an earlier member's call —
  // treat that as "join the existing registration" instead of erroring on
  // the unique-teamId conflict. All writes are one transaction so a member
  // never ends up half-registered if a later step fails.
  const hackathonTeam = await prisma.$transaction(async (tx) => {
    await tx.hackathonParticipant.update({
      where: { userId_hackathonId: { userId: user.id, hackathonId: id } },
      data: { teamId: team.id, status: 'TEAM_FORMED' }
    })

    const existingHackathonTeam = await tx.hackathonTeam.findUnique({
      where: { teamId: team.id }
    })

    // Fall back to the team's own already-linked project when the caller
    // doesn't explicitly pass one — a team that formed around a project
    // shouldn't silently lose that link just because this call omitted a
    // field the team already answered at creation time. The fallback is
    // safe to trust: team.projectId was only ever set by the team's real
    // owner, whose ownership of that project was already verified then.
    const record = existingHackathonTeam ?? await tx.hackathonTeam.create({
      data: {
        hackathonId: id,
        teamId: team.id,
        name: team.name,
        projectId: bodyResult.data.projectId ?? team.projectId,
      }
    })

    await tx.hackathonTeamMember.upsert({
      where: { hackathonTeamId_userId: { hackathonTeamId: record.id, userId: user.id } },
      create: { hackathonTeamId: record.id, userId: user.id, role: isOwner ? 'OWNER' : 'MEMBER' },
      update: {}
    })

    if (!existingHackathonTeam) {
      await tx.team.update({ where: { id: team.id }, data: { hackathonId: id } })
    }

    return record
  })

  await awardXp(prisma, user.id, 'TEAM_FORMED', `Formed team for "${hackathon.name}"`)

  return createApiResponse({ success: true, teamId: team.id, hackathonTeamId: hackathonTeam.id })
}, { rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'hackathons:team-register' } })
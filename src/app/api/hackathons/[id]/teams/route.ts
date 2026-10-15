import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError, checkMembership } from '@/lib/api/handler'
import { z } from 'zod'
import { recordActivity } from '@/lib/activity'
import { emit, transactWithEvents } from '@/lib/events'

const registerTeamSchema = z.object({
  teamId: z.string(),
  projectId: z.string().optional(),
})

export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const url = new URL(request.url)
  const id = url.pathname.split('/').slice(-2)[0]

  if (!id) {
    return createApiError('MISSING_PARAMETER', { params: { parameters: 'hackathonId' } })
  }

  const hackathon = await prisma.hackathon.findUnique({ where: { id } })
  if (!hackathon) {
    return createApiError('HACKATHON_NOT_FOUND')
  }

  if (hackathon.status !== 'UPCOMING' && hackathon.status !== 'ACTIVE') {
    return createApiError('HACKATHON_TEAM_REGISTRATION_CLOSED')
  }

  const participant = await prisma.hackathonParticipant.findUnique({
    where: { userId_hackathonId: { userId: user.id, hackathonId: id } }
  })
  if (!participant) {
    return createApiError('HACKATHON_REGISTRATION_REQUIRED')
  }

  if (participant.teamId) {
    return createApiError('ALREADY_IN_HACKATHON_TEAM')
  }

  const bodyResult = await validateBody(registerTeamSchema)(request)
  if (bodyResult instanceof Response) return bodyResult

  const team = await prisma.team.findUnique({
    where: { id: bodyResult.data.teamId },
    include: { members: true }
  })

  if (!team) {
    return createApiError('TEAM_NOT_FOUND')
  }

  if (team.hackathonId && team.hackathonId !== id) {
    return createApiError('TEAM_WRONG_HACKATHON')
  }

  if (team.members.length >= (team.maxSize || 5)) {
    return createApiError('TEAM_FULL')
  }

  // Team.maxSize is the team's own cap (enforced above); this hackathon may
  // additionally declare its own team-size bounds, independent of that
  // number - a team within its own maxSize can still be too big or too
  // small for this specific hackathon's rules.
  if (team.members.length > hackathon.maxTeamSize) {
    return createApiError('HACKATHON_TEAM_TOO_LARGE', { params: { max: hackathon.maxTeamSize } })
  }
  if (team.members.length < hackathon.minTeamSize) {
    return createApiError('HACKATHON_TEAM_TOO_SMALL', { params: { min: hackathon.minTeamSize } })
  }

  const isMember = team.members.some((m: { userId: string }) => m.userId === user.id)
  const isOwner = team.ownerId === user.id

  if (!isMember && !isOwner) {
    const application = await prisma.teamApplication.findUnique({
      where: { userId_teamId: { userId: user.id, teamId: team.id } }
    })
    if (!application || application.status !== 'ACCEPTED') {
      return createApiError('NOT_TEAM_MEMBER')
    }
  }

  if (bodyResult.data.projectId) {
    const project = await prisma.project.findUnique({ where: { id: bodyResult.data.projectId } })
    if (!project || project.ownerId !== user.id) {
      return createApiError('PROJECT_NOT_OWNED')
    }
  }

  // Any team member can call this (isMember/isOwner check above), so the
  // HackathonTeam row may already exist from an earlier member's call —
  // treat that as "join the existing registration" instead of erroring on
  // the unique-teamId conflict. All writes are one transaction so a member
  // never ends up half-registered if a later step fails.
  const { value: hackathonTeam, scope } = await transactWithEvents(prisma, async (tx) => {
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

    // Same pattern as team-join: registering for a hackathon gives the
    // registering member access to the hackathon's own Conversation, not
    // just the team's. A hackathon created before conversation-wiring
    // shipped may have no Conversation yet — skip rather than crash.
    const hackathonConversation = await tx.conversation.findUnique({ where: { hackathonId: id } })
    if (hackathonConversation) {
      await tx.conversationMember.upsert({
        where: { userId_conversationId: { userId: user.id, conversationId: hackathonConversation.id } },
        create: { userId: user.id, conversationId: hackathonConversation.id, role: 'MEMBER' },
        update: {}
      })
    }

    await recordActivity(tx, user.id, 'TEAM_JOINED', `Formed team for "${hackathon.name}"`, {
      link: `/hackathons/${hackathon.slug}`
    })
    await emit(tx, 'TEAM_FORMED', { userId: user.id, teamId: team.id, hackathonId: id, hackathonName: hackathon.name })

    return record
  })

  return createApiResponse({ success: true, teamId: team.id, hackathonTeamId: hackathonTeam.id, rewards: await scope.rewardsFor(prisma, user.id) })
}, { rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'hackathons:team-register' } })
import { NextRequest, NextResponse } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { recordActivity } from '@/lib/activity'
import { emit, transactWithEvents } from '@/lib/events'
import {
  childIdFromPath,
  isValidId,
  loadProjectAccess,
  projectIdFromPath,
  type ProjectAccess,
} from '@/lib/progress'
import { milestoneResponse, milestoneSelect } from '@/lib/milestones'
import { patchMilestoneSchema } from './schema'

type Resolved =
  | { ok: false; error: NextResponse }
  | { ok: true; access: ProjectAccess; projectId: string; milestoneId: string }

// unknown project -> 404; non-member -> 403 (whether or not the milestone
// exists); member but the milestone is in another project or absent -> 404.
async function resolve(
  request: NextRequest,
  prisma: Parameters<typeof loadProjectAccess>[0],
  user: { id: string; role: string },
  allow: (access: ProjectAccess) => boolean
): Promise<Resolved> {
  const projectId = projectIdFromPath(request)
  const milestoneId = childIdFromPath(request)
  if (!isValidId(projectId) || !isValidId(milestoneId)) return { ok: false, error: createApiError('MILESTONE_NOT_FOUND') }

  const access = await loadProjectAccess(prisma, projectId, user)
  if (!access) return { ok: false, error: createApiError('PROJECT_NOT_FOUND') }
  if (!allow(access)) return { ok: false, error: createApiError('FORBIDDEN') }

  const exists = await prisma.milestone.findFirst({ where: { id: milestoneId, projectId }, select: { id: true } })
  if (!exists) return { ok: false, error: createApiError('MILESTONE_NOT_FOUND') }

  return { ok: true, access, projectId, milestoneId }
}

// Any project member may edit a milestone or mark it complete / incomplete.
export const PATCH = withAuth(async (request: NextRequest, { prisma, user }) => {
  const resolved = await resolve(request, prisma, user, (a) => a.isMember)
  if (!resolved.ok) return resolved.error
  const { access, projectId, milestoneId } = resolved

  const body = await validateBody(patchMilestoneSchema)(request)
  if (body instanceof Response) return body
  const { completed, ...fields } = body.data
  const { project } = access

  const { value: updated, scope } = await transactWithEvents(prisma, async (tx) => {
    const edits = {
      title: fields.title,
      description: fields.description,
      dueDate: fields.dueDate === undefined ? undefined : fields.dueDate === null ? null : new Date(fields.dueDate),
      order: fields.order,
    }
    if (Object.values(edits).some((value) => value !== undefined)) {
      await tx.milestone.updateMany({ where: { id: milestoneId, projectId }, data: edits })
    }

    if (completed === true) {
      // The conditional update is the guard: only the transaction that flips
      // completedAt from null gets count 1, so parallel completions of one
      // milestone run the side effects exactly once.
      const flipped = await tx.milestone.updateMany({
        where: { id: milestoneId, projectId, completedAt: null },
        data: { completedAt: new Date() },
      })

      if (flipped.count === 1) {
        // A milestone that was completed, reopened and completed again is
        // announced only the first time, so toggling cannot farm activity.
        const alreadyAnnounced = await tx.activity.findFirst({
          where: { type: 'MILESTONE_COMPLETED', projectId, metadata: { path: ['milestoneId'], equals: milestoneId } },
          select: { id: true },
        })

        if (!alreadyAnnounced) {
          const current = await tx.milestone.findFirst({ where: { id: milestoneId, projectId }, select: { title: true } })
          const title = current?.title ?? 'Milestone'

          await recordActivity(tx, user.id, 'MILESTONE_COMPLETED', `Completed milestone "${title}" on "${project.name}"`, {
            link: `/projects/${project.slug}`,
            projectId,
            metadata: { milestoneId },
          })
          await emit(tx, 'MILESTONE_COMPLETED', { userId: user.id, projectId, milestoneId })
          await tx.projectUpdate.create({
            data: {
              projectId,
              authorId: user.id,
              type: 'MILESTONE',
              title: `Milestone completed: ${title}`.slice(0, 200),
              content: `${user.name || user.username || 'A teammate'} completed the milestone "${title}".`,
            },
          })
        }
      }
    } else if (completed === false) {
      // Reopening clears the timestamp only; the earlier activity, update
      // post and achievement stay, they record something that did happen.
      await tx.milestone.updateMany({
        where: { id: milestoneId, projectId, completedAt: { not: null } },
        data: { completedAt: null },
      })
    }

    return tx.milestone.findFirst({ where: { id: milestoneId, projectId }, select: milestoneSelect })
  })

  if (!updated) return createApiError('MILESTONE_NOT_FOUND')
  return createApiResponse({ ...milestoneResponse(updated), rewards: await scope.rewardsFor(prisma, user.id) })
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'progress:milestone-edit' } })

// Removing a milestone is a planning decision for the project owner (or a
// platform admin), not something any member can do.
export const DELETE = withAuth(async (request: NextRequest, { prisma, user }) => {
  const resolved = await resolve(request, prisma, user, (a) => a.isOwner || a.isAdmin)
  if (!resolved.ok) return resolved.error

  await prisma.milestone.deleteMany({ where: { id: resolved.milestoneId, projectId: resolved.projectId } })
  return createApiResponse({ success: true })
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'progress:milestone-delete' } })

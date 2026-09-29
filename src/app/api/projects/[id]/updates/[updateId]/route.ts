import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import type { ProjectAccess } from '@/lib/progress'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import {
  authorSelect,
  childIdFromPath,
  isValidId,
  loadProjectAccess,
  projectIdFromPath,
} from '@/lib/progress'

const editUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    content: z.string().trim().min(1).max(10000).optional(),
  })
  .refine((v) => v.title !== undefined || v.content !== undefined, { message: 'Nothing to update' })

const updateSelect = {
  id: true,
  projectId: true,
  authorId: true,
  title: true,
  content: true,
  type: true,
  createdAt: true,
  author: { select: authorSelect },
} as const

// Shared prologue. Order matters for what a caller can learn:
//   unknown project -> 404, non-member -> 403 (regardless of whether the
//   update exists), member but the update belongs to another project (or does
//   not exist) -> 404.
type Resolved =
  | { ok: false; error: NextResponse }
  | { ok: true; access: ProjectAccess; update: UpdateRow; projectId: string }
type UpdateRow = { id: string; authorId: string; type: string }

async function resolve(
  request: NextRequest,
  prisma: Parameters<typeof loadProjectAccess>[0],
  user: { id: string; role: string }
): Promise<Resolved> {
  const projectId = projectIdFromPath(request)
  const updateId = childIdFromPath(request)
  if (!isValidId(projectId) || !isValidId(updateId)) return { ok: false, error: createApiError('Update not found', 404) }

  const access = await loadProjectAccess(prisma, projectId, user)
  if (!access) return { ok: false, error: createApiError('Project not found', 404) }
  if (!access.isMember && !access.isAdmin) return { ok: false, error: createApiError('Forbidden', 403) }

  const update = await prisma.projectUpdate.findFirst({ where: { id: updateId, projectId }, select: updateSelect })
  if (!update) return { ok: false, error: createApiError('Update not found', 404) }

  return { ok: true, access, update, projectId }
}

// Editing rewrites someone's words, so it is limited to the author (who must
// still be a project member) - not the owner - plus platform admins.
// System-generated MILESTONE/SHIPPED posts are never editable.
export const PATCH = withAuth(async (request: NextRequest, { prisma, user }) => {
  const resolved = await resolve(request, prisma, user)
  if (!resolved.ok) return resolved.error
  const { access, update, projectId } = resolved

  const isAuthor = update.authorId === user.id
  if (!(isAuthor && access.isMember) && !access.isAdmin) return createApiError('Forbidden', 403)
  if (update.type !== 'UPDATE' && update.type !== 'ANNOUNCEMENT') {
    return createApiError('System-generated updates cannot be edited', 400)
  }

  const body = await validateBody(editUpdateSchema)(request)
  if (body instanceof Response) return body

  await prisma.projectUpdate.updateMany({
    where: { id: update.id, projectId },
    data: { title: body.data.title, content: body.data.content },
  })
  const fresh = await prisma.projectUpdate.findFirst({ where: { id: update.id, projectId }, select: updateSelect })
  if (!fresh) return createApiError('Update not found', 404)

  return createApiResponse(fresh)
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'progress:update-edit' } })

// Deleting is moderation as well as self-service: the author, the project
// owner, or a platform admin.
export const DELETE = withAuth(async (request: NextRequest, { prisma, user }) => {
  const resolved = await resolve(request, prisma, user)
  if (!resolved.ok) return resolved.error
  const { access, update, projectId } = resolved

  const isAuthor = update.authorId === user.id
  if (!(isAuthor && access.isMember) && !access.isOwner && !access.isAdmin) return createApiError('Forbidden', 403)

  await prisma.projectUpdate.deleteMany({ where: { id: update.id, projectId } })
  return createApiResponse({ success: true })
}, { rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'progress:update-delete' } })

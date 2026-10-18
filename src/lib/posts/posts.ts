import type { PostKind, PostVisibility, Prisma, PrismaClient, ShipPost } from '@prisma/client'
import { z } from 'zod'
import type { ErrorCode } from '@/lib/api/errors'
import { blockRelation, blockedPeerIds } from '@/lib/blocks'
import { transactWithEvents, emit } from '@/lib/events'
import { track } from '@/lib/infra/analytics'
import { getStorage, type Storage } from '@/lib/infra/storage'
import { loadPersonSummaries } from '@/lib/matching/summary'
import { mediaUrl, readyAssets } from '@/lib/media-assets'
import { MEDIA_LIMITS } from '@/lib/media'
import { shipProjectOnce } from '@/lib/ship'
import { SHIP_DAY_TAG, shipDayKeyOf } from '@/lib/ship-day'
import { excerptOf, isPublicLink, sanitizeLine, sanitizeMarkdown } from './sanitize'

// Ship posts: something a builder shows. Created, edited (a revision count), soft-deleted. The text is Markdown, sanitised on the way in (sanitize.ts); media are the author's own
// confirmed uploads; co-authors, the project and the crew must fit together. A SHIP post for a project that is not yet shipped ships it through the one ship gate (src/lib/ship.ts), so there
// is no second award path; an UPDATE or DEVLOG post on a project counts as a project update, which carries the existing XP and caps. A post made on the author's own Friday carries the
// Ship Day tag.

type Db = PrismaClient
type Tx = Prisma.TransactionClient

export const POST_KINDS = ['SHIP', 'UPDATE', 'DEVLOG', 'DEMO'] as const
export const POST_VISIBILITIES = ['PUBLIC', 'FOLLOWERS', 'CREW'] as const
/** A comment or edit may not change a post's author, kind or media; the fields below are what an edit may change. */
export const EDIT_FIELDS = ['title', 'body', 'links', 'stackTags', 'visibility'] as const

const tag = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9+#.\-]{0,29}$/, 'Letters, digits and + # . - only')

export const createPostSchema = z
  .object({
    kind: z.enum(POST_KINDS),
    title: z.string().min(3).max(120),
    body: z.string().min(1).max(10_000),
    projectId: z.string().min(1).max(64).optional(),
    teamId: z.string().min(1).max(64).optional(),
    links: z.array(z.string().max(500).refine(isPublicLink, 'An http or https link')).max(5).default([]),
    mediaIds: z.array(z.string().min(1).max(64)).max(MEDIA_LIMITS.maxPerPost).default([]),
    stackTags: z.array(tag).max(10).default([]),
    coAuthorIds: z.array(z.string().min(1).max(64)).max(5).default([]),
    visibility: z.enum(POST_VISIBILITIES).default('PUBLIC'),
  })
  .strict()

export type CreatePostInput = z.infer<typeof createPostSchema>

export const updatePostSchema = z
  .object({
    title: z.string().min(3).max(120),
    body: z.string().min(1).max(10_000),
    links: z.array(z.string().max(500).refine(isPublicLink, 'An http or https link')).max(5),
    stackTags: z.array(tag).max(10),
    visibility: z.enum(POST_VISIBILITIES),
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Send at least one field')

export type UpdatePostInput = z.infer<typeof updatePostSchema>

export interface PostMedia {
  assetId: string
  key: string
  type: 'IMAGE' | 'GIF' | 'VIDEO'
  width: number
  height: number
  durationMs: number | null
}

export interface PostView {
  id: string
  kind: PostKind
  title: string
  body: string
  links: string[]
  media: { id: string; type: PostMedia['type']; url: string; width: number; height: number; durationMs: number | null }[]
  stackTags: string[]
  visibility: PostVisibility
  shipDay: boolean
  author: PostPerson
  coAuthors: PostPerson[]
  project: { id: string; name: string; slug: string } | null
  teamId: string | null
  propsScore: number
  propsCount: number
  commentCount: number
  /** Whether the viewer has given Props. */
  yourProps: boolean
  revision: number
  createdAt: string
  editedAt: string | null
}

export interface PostPerson {
  id: string
  name: string | null
  username: string
  image: string | null
  level: number
  tier: string
}

export type PostFailure = { ok: false; code: ErrorCode; details?: unknown }
const fail = (code: ErrorCode, details?: unknown): PostFailure => ({ ok: false, code, ...(details !== undefined ? { details } : {}) })

// --- Who may post where ------------------------------------------------------------------------------------

/** The people who belong to a post's context: the members of its project, or of its crew. */
async function memberIds(db: Pick<Db, 'projectMember' | 'project' | 'teamMember'>, projectId: string | undefined, teamId: string | undefined): Promise<Set<string>> {
  const ids = new Set<string>()
  if (projectId) {
    const project = await db.project.findUnique({ where: { id: projectId }, select: { ownerId: true } })
    if (project) ids.add(project.ownerId)
    for (const member of await db.projectMember.findMany({ where: { projectId }, select: { userId: true } })) ids.add(member.userId)
  }
  if (teamId) for (const member of await db.teamMember.findMany({ where: { teamId }, select: { userId: true } })) ids.add(member.userId)
  return ids
}

export type CreatePostResult = { ok: true; post: ShipPost; shipped: boolean } | PostFailure

export async function createPost(db: Db, author: { id: string; timezone: string | null }, input: CreatePostInput, now: Date = new Date()): Promise<CreatePostResult> {
  const { projectId, teamId } = input
  if (input.kind === 'SHIP' && !projectId) return fail('POST_INVALID_CONTEXT', { projectId: ['A SHIP post is about a project'] })
  if (input.visibility === 'CREW' && !projectId && !teamId) return fail('POST_INVALID_CONTEXT', { visibility: ['A crew-only post needs a project or a crew'] })

  const members = await memberIds(db, projectId, teamId)
  if ((projectId || teamId) && !members.has(author.id)) return fail('POST_INVALID_CONTEXT')
  if (projectId && !(await db.project.findUnique({ where: { id: projectId }, select: { id: true } }))) return fail('POST_INVALID_CONTEXT')
  if (teamId && !(await db.team.findUnique({ where: { id: teamId }, select: { id: true } }))) return fail('POST_INVALID_CONTEXT')

  const coAuthorIds = [...new Set(input.coAuthorIds)].filter((id) => id !== author.id)
  for (const id of coAuthorIds) {
    if (!members.has(id)) return fail('POST_COAUTHOR_NOT_MEMBER', { coAuthorIds: [id] })
    if (await blockRelation(db, author.id, id)) return fail('POST_COAUTHOR_NOT_MEMBER', { coAuthorIds: [id] })
  }

  const assets = await readyAssets(db, author.id, 'POST_MEDIA', input.mediaIds)
  if (assets.length !== new Set(input.mediaIds).size) return fail('MEDIA_NOT_FOUND', { mediaIds: ['One of these is not your confirmed upload'] })
  const media: PostMedia[] = assets.map((asset) => ({ assetId: asset.id, key: asset.key, type: asset.kind, width: asset.width, height: asset.height, durationMs: asset.durationMs }))

  const shipDayKey = shipDayKeyOf(now, author.timezone)
  const stackTags = [...new Set([...input.stackTags, ...(shipDayKey ? [SHIP_DAY_TAG] : [])])]
  const body = sanitizeMarkdown(input.body)
  const title = sanitizeLine(input.title)
  if (body.length === 0 || title.length < 3) return fail('VALIDATION_FAILED', { body: ['Write something'] })

  const outcome = await transactWithEvents(db, async (tx) => {
    // The one-time ship gate: a SHIP post for a project that has not shipped yet ships it (and pays once); for one that has, it is just a post.
    let shipped = false
    if (input.kind === 'SHIP' && projectId) shipped = await shipProjectOnce(tx, { userId: author.id, projectId })

    // An UPDATE or DEVLOG on a project is a project update: the existing XP and daily cap.
    let projectUpdateId: string | null = null
    if ((input.kind === 'UPDATE' || input.kind === 'DEVLOG') && projectId) {
      const update = await tx.projectUpdate.create({ data: { projectId, authorId: author.id, title, content: excerptOf(body, 2000), type: 'UPDATE' }, select: { id: true } })
      projectUpdateId = update.id
      await emit(tx, 'PROJECT_UPDATE_POSTED', { userId: author.id, projectId, updateId: update.id })
    }

    const post = await tx.shipPost.create({
      data: {
        authorId: author.id,
        projectId: projectId ?? null,
        teamId: teamId ?? null,
        kind: input.kind,
        title,
        body,
        links: input.links,
        media: media as unknown as Prisma.InputJsonValue,
        stackTags,
        coAuthorIds,
        visibility: input.visibility,
        shipDayKey,
        projectUpdateId,
        createdAt: now,
      },
    })
    if (shipDayKey) await emit(tx, 'POST_SHIP_DAY', { userId: author.id, postId: post.id, dateKey: shipDayKey, kind: input.kind })
    return { post, shipped }
  })
  await track(author.id, 'post_created', { kind: input.kind, shipDay: shipDayKey !== null, shipped: outcome.value.shipped })
  return { ok: true, post: outcome.value.post, shipped: outcome.value.shipped }
}

export async function updatePost(db: Db, userId: string, postId: string, input: UpdatePostInput, now: Date = new Date()): Promise<{ ok: true; post: ShipPost } | PostFailure> {
  const post = await db.shipPost.findUnique({ where: { id: postId } })
  if (!post || post.deletedAt) return fail('POST_NOT_FOUND')
  // Only the author edits; a co-author shares the credit, not the pen.
  if (post.authorId !== userId) return fail(post.coAuthorIds.includes(userId) ? 'FORBIDDEN' : 'POST_NOT_FOUND')
  if (input.visibility === 'CREW' && !post.projectId && !post.teamId) return fail('POST_INVALID_CONTEXT', { visibility: ['A crew-only post needs a project or a crew'] })
  const data: Prisma.ShipPostUpdateInput = { revision: { increment: 1 }, editedAt: now }
  if (input.title !== undefined) data.title = sanitizeLine(input.title)
  if (input.body !== undefined) data.body = sanitizeMarkdown(input.body)
  if (input.links !== undefined) data.links = input.links
  if (input.stackTags !== undefined) data.stackTags = [...new Set([...input.stackTags, ...(post.shipDayKey ? [SHIP_DAY_TAG] : [])])]
  if (input.visibility !== undefined) data.visibility = input.visibility
  return { ok: true, post: await db.shipPost.update({ where: { id: postId }, data }) }
}

/** Soft delete: the post disappears from every read; its Props and comments stay in the table. Author or an admin. */
export async function deletePost(db: Db, userId: string, role: string, postId: string, now: Date = new Date()): Promise<boolean> {
  const post = await db.shipPost.findUnique({ where: { id: postId }, select: { authorId: true, deletedAt: true } })
  if (!post || post.deletedAt) return false
  if (post.authorId !== userId && role !== 'ADMIN') return false
  await db.shipPost.update({ where: { id: postId }, data: { deletedAt: now } })
  return true
}

// --- Who may see a post ------------------------------------------------------------------------------------

/** The sets a viewer's visibility is judged by, loaded once for a whole page of posts. */
export interface ViewerScope {
  userId: string
  following: Set<string>
  projectIds: Set<string>
  teamIds: Set<string>
  hidden: Set<string>
}

export async function loadViewerScope(db: Db, userId: string): Promise<ViewerScope> {
  const [follows, projects, ownedProjects, teams, hidden] = await Promise.all([
    db.follow.findMany({ where: { followerId: userId }, select: { followeeId: true } }),
    db.projectMember.findMany({ where: { userId }, select: { projectId: true } }),
    db.project.findMany({ where: { ownerId: userId }, select: { id: true } }),
    db.teamMember.findMany({ where: { userId }, select: { teamId: true } }),
    blockedPeerIds(db, userId),
  ])
  return {
    userId,
    following: new Set(follows.map((row) => row.followeeId)),
    projectIds: new Set([...projects.map((row) => row.projectId), ...ownedProjects.map((row) => row.id)]),
    teamIds: new Set(teams.map((row) => row.teamId)),
    hidden: new Set(hidden),
  }
}

export function canView(post: Pick<ShipPost, 'authorId' | 'coAuthorIds' | 'visibility' | 'projectId' | 'teamId' | 'deletedAt'>, scope: ViewerScope): boolean {
  if (post.deletedAt) return false
  const mine = post.authorId === scope.userId || post.coAuthorIds.includes(scope.userId)
  if (mine) return true
  if (scope.hidden.has(post.authorId)) return false
  if (post.visibility === 'PUBLIC') return true
  if (post.visibility === 'FOLLOWERS') return scope.following.has(post.authorId)
  return Boolean((post.projectId && scope.projectIds.has(post.projectId)) || (post.teamId && scope.teamIds.has(post.teamId)))
}

/** The Prisma `where` that is `canView` for a query over many posts. */
export function visibleWhere(scope: ViewerScope): Prisma.ShipPostWhereInput {
  return {
    deletedAt: null,
    authorId: { notIn: [...scope.hidden] },
    OR: [
      { authorId: scope.userId },
      { coAuthorIds: { has: scope.userId } },
      { visibility: 'PUBLIC' },
      { visibility: 'FOLLOWERS', authorId: { in: [...scope.following] } },
      { visibility: 'CREW', OR: [{ projectId: { in: [...scope.projectIds] } }, { teamId: { in: [...scope.teamIds] } }] },
    ],
  }
}

// --- Views ------------------------------------------------------------------------------------------------

export async function toPostViews(db: Db, viewerId: string, posts: readonly ShipPost[], storage: Pick<Storage, 'publicUrl' | 'signedReadUrl'> = getStorage()): Promise<PostView[]> {
  if (posts.length === 0) return []
  const personIds = [...new Set(posts.flatMap((post) => [post.authorId, ...post.coAuthorIds]))]
  const projectIds = [...new Set(posts.flatMap((post) => (post.projectId ? [post.projectId] : [])))]
  const [people, avatars, projects, given] = await Promise.all([
    loadPersonSummaries(db, personIds),
    db.user.findMany({ where: { id: { in: personIds } }, select: { id: true, image: true } }),
    projectIds.length > 0 ? db.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, name: true, slug: true } }) : Promise.resolve([]),
    db.prop.findMany({ where: { userId: viewerId, postId: { in: posts.map((post) => post.id) } }, select: { postId: true } }),
  ])
  const imageOf = new Map(avatars.map((row) => [row.id, row.image]))
  const personOf = (id: string): PostPerson | null => {
    const person = people.get(id)
    return person ? { id: person.id, name: person.name, username: person.username, image: imageOf.get(id) ?? null, level: person.level, tier: person.tier } : null
  }
  const projectOf = new Map(projects.map((project) => [project.id, project]))
  const gave = new Set(given.map((row) => row.postId))

  const views: PostView[] = []
  for (const post of posts) {
    const author = personOf(post.authorId)
    if (!author) continue
    const media = []
    for (const item of (Array.isArray(post.media) ? post.media : []) as unknown as PostMedia[]) {
      media.push({ id: item.assetId, type: item.type, url: await mediaUrl(storage as Storage, item.key), width: item.width, height: item.height, durationMs: item.durationMs })
    }
    views.push({
      id: post.id,
      kind: post.kind,
      title: post.title,
      body: post.body,
      links: post.links,
      media,
      stackTags: post.stackTags,
      visibility: post.visibility,
      shipDay: post.shipDayKey !== null,
      author,
      coAuthors: post.coAuthorIds.flatMap((id) => personOf(id) ?? []),
      project: post.projectId ? (projectOf.get(post.projectId) ?? null) : null,
      teamId: post.teamId,
      propsScore: Math.round(post.propsScore * 100) / 100,
      propsCount: post.propsCount,
      commentCount: post.commentCount,
      yourProps: gave.has(post.id),
      revision: post.revision,
      createdAt: post.createdAt.toISOString(),
      editedAt: post.editedAt?.toISOString() ?? null,
    })
  }
  return views
}

/** One post as the viewer may see it, or null (missing, deleted, hidden by a block, or not for them). */
export async function getPostFor(db: Db, viewerId: string, postId: string): Promise<{ post: ShipPost; view: PostView } | null> {
  const post = await db.shipPost.findUnique({ where: { id: postId } })
  if (!post) return null
  const scope = await loadViewerScope(db, viewerId)
  if (!canView(post, scope)) return null
  const [view] = await toPostViews(db, viewerId, [post])
  return view ? { post, view } : null
}

export type { Tx }

import type { Comment, PrismaClient } from '@prisma/client'
import { z } from 'zod'
import type { ErrorCode } from '@/lib/api/errors'
import { blockedPeerIds } from '@/lib/blocks'
import { transactWithEvents } from '@/lib/events'
import { track } from '@/lib/infra/analytics'
import { loadPersonSummaries } from '@/lib/matching/summary'
import { coalesceNotification } from '@/lib/notifications'
import { accountDistrust } from '@/lib/trust'
import { canView, loadViewerScope } from './posts'
import { excerptOf, sanitizeMarkdown } from './sanitize'

// Comments on a post, one level of threading: a reply's parent is always a top-level comment. Soft delete (the thread keeps its shape: the text goes, a marker stays), an edit
// window of COMMENT_EDIT_MINUTES, blocks respected both ways. Telling the post's author (and the person replied to) is a coalesced notification, and a fresh or unverified account does not
// ping anyone (the trust gate): it can still comment, and the comment is there, but nobody is notified about it.

type Db = PrismaClient

export const COMMENT_EDIT_MINUTES = 15
export const COMMENT_MAX_REPLIES_SHOWN = 20

export const commentSchema = z.object({ body: z.string().min(1).max(2000), parentId: z.string().min(1).max(64).optional() }).strict()
export const editCommentSchema = z.object({ body: z.string().min(1).max(2000) }).strict()

export interface CommentView {
  id: string
  postId: string
  parentId: string | null
  author: { id: string; name: string | null; username: string; level: number; tier: string } | null
  /** Null once deleted. */
  body: string | null
  deleted: boolean
  createdAt: string
  editedAt: string | null
  replies?: CommentView[]
  replyCount?: number
}

export type CommentResult = { ok: true; comment: Comment } | { ok: false; code: ErrorCode; params?: Record<string, string | number> }

export async function createComment(db: Db, authorId: string, postId: string, input: z.infer<typeof commentSchema>, now: Date = new Date()): Promise<CommentResult> {
  const post = await db.shipPost.findUnique({ where: { id: postId } })
  if (!post) return { ok: false, code: 'POST_NOT_FOUND' }
  if (!canView(post, await loadViewerScope(db, authorId))) return { ok: false, code: 'POST_NOT_FOUND' }
  const body = sanitizeMarkdown(input.body)
  if (body.length === 0) return { ok: false, code: 'VALIDATION_FAILED' }

  let parent: Comment | null = null
  if (input.parentId) {
    parent = await db.comment.findUnique({ where: { id: input.parentId } })
    if (!parent || parent.postId !== postId || parent.deletedAt) return { ok: false, code: 'COMMENT_NOT_FOUND' }
    if (parent.parentId) return { ok: false, code: 'COMMENT_REPLY_DEPTH' }
    // Someone who blocked (or was blocked by) the person being replied to cannot reply to them.
    if ((await blockedPeerIds(db, authorId)).includes(parent.authorId)) return { ok: false, code: 'COMMENT_NOT_FOUND' }
  }
  const author = await db.user.findUnique({ where: { id: authorId }, select: { createdAt: true, isEmailVerified: true, name: true, username: true } })
  if (!author) return { ok: false, code: 'USER_NOT_FOUND' }
  const trusted = accountDistrust(author, now) === null

  const outcome = await transactWithEvents(db, async (tx) => {
    const comment = await tx.comment.create({ data: { postId, authorId, parentId: parent?.id ?? null, body, createdAt: now } })
    await tx.shipPost.update({ where: { id: postId }, data: { commentCount: { increment: 1 } } })
    if (trusted) {
      const name = author.name || author.username
      if (post.authorId !== authorId) {
        await coalesceNotification(tx, {
          userId: post.authorId,
          kind: 'COMMENT',
          title: 'New comment',
          subject: `comment:${postId}`,
          message: (count) => (count === 1 ? `${name} commented on "${post.title}": ${excerptOf(body, 80)}` : `${count} new comments on "${post.title}"`),
          link: `/posts/${postId}`,
          metadata: { postId, commentId: comment.id },
          now,
        })
      }
      if (parent && parent.authorId !== authorId && parent.authorId !== post.authorId) {
        await coalesceNotification(tx, {
          userId: parent.authorId,
          kind: 'COMMENT',
          title: 'New reply',
          subject: `reply:${parent.id}`,
          message: (count) => (count === 1 ? `${name} replied to you: ${excerptOf(body, 80)}` : `${count} new replies to your comment`),
          link: `/posts/${postId}`,
          metadata: { postId, commentId: comment.id, parentId: parent.id },
          now,
        })
      }
    }
    return comment
  })
  await track(authorId, 'comment_created', { reply: parent !== null })
  return { ok: true, comment: outcome.value }
}

export async function editComment(db: Db, userId: string, commentId: string, body: string, now: Date = new Date()): Promise<CommentResult> {
  const comment = await db.comment.findUnique({ where: { id: commentId } })
  if (!comment || comment.deletedAt || comment.authorId !== userId) return { ok: false, code: 'COMMENT_NOT_FOUND' }
  if (now.getTime() - comment.createdAt.getTime() > COMMENT_EDIT_MINUTES * 60_000) return { ok: false, code: 'COMMENT_EDIT_WINDOW_CLOSED', params: { minutes: COMMENT_EDIT_MINUTES } }
  const text = sanitizeMarkdown(body)
  if (text.length === 0) return { ok: false, code: 'VALIDATION_FAILED' }
  return { ok: true, comment: await db.comment.update({ where: { id: commentId }, data: { body: text, editedAt: now } }) }
}

/** Soft delete by the author of the comment, the author of the post, or an admin. */
export async function deleteComment(db: Db, userId: string, role: string, commentId: string, now: Date = new Date()): Promise<boolean> {
  const comment = await db.comment.findUnique({ where: { id: commentId }, include: { post: { select: { authorId: true } } } })
  if (!comment || comment.deletedAt) return false
  if (comment.authorId !== userId && comment.post.authorId !== userId && role !== 'ADMIN') return false
  await db.$transaction([
    db.comment.update({ where: { id: commentId }, data: { deletedAt: now } }),
    db.shipPost.update({ where: { id: comment.postId }, data: { commentCount: { decrement: 1 } } }),
  ])
  return true
}

export async function listComments(db: Db, viewerId: string, postId: string, options: { after?: string; limit: number }): Promise<{ comments: CommentView[]; nextCursor: string | null } | null> {
  const post = await db.shipPost.findUnique({ where: { id: postId } })
  if (!post || !canView(post, await loadViewerScope(db, viewerId))) return null
  const hidden = await blockedPeerIds(db, viewerId)
  const visibleAuthor = hidden.length > 0 ? { authorId: { notIn: hidden } } : {}
  const tops = await db.comment.findMany({
    where: { postId, parentId: null, ...visibleAuthor, ...(options.after ? { id: { gt: options.after } } : {}) },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: options.limit + 1,
  })
  const page = tops.slice(0, options.limit)
  const replies = page.length > 0 ? await db.comment.findMany({ where: { parentId: { in: page.map((c) => c.id) }, ...visibleAuthor }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }) : []
  const people = await loadPersonSummaries(db, [...new Set([...page, ...replies].map((c) => c.authorId))])
  const view = (comment: Comment): CommentView => {
    const person = people.get(comment.authorId)
    return {
      id: comment.id,
      postId: comment.postId,
      parentId: comment.parentId,
      author: person && !comment.deletedAt ? { id: person.id, name: person.name, username: person.username, level: person.level, tier: person.tier } : null,
      body: comment.deletedAt ? null : comment.body,
      deleted: comment.deletedAt !== null,
      createdAt: comment.createdAt.toISOString(),
      editedAt: comment.editedAt?.toISOString() ?? null,
    }
  }
  const byParent = new Map<string, Comment[]>()
  for (const reply of replies) byParent.set(reply.parentId!, [...(byParent.get(reply.parentId!) ?? []), reply])
  return {
    comments: page.map((top) => {
      const list = byParent.get(top.id) ?? []
      return { ...view(top), replyCount: list.length, replies: list.slice(0, COMMENT_MAX_REPLIES_SHOWN).map(view) }
    }),
    nextCursor: tops.length > options.limit ? page[page.length - 1].id : null,
  }
}

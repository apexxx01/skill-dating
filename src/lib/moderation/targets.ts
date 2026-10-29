import type { Prisma, PrismaClient, ReportTarget } from '@prisma/client'
import { canView, loadViewerScope } from '@/lib/posts/posts'
import { purgeRomance } from '@/lib/romance/lifecycle'

// What can be reported, and what a moderator can do to it. Each target type knows how to find the thing, who made it, whether the reporter could see it
// (you can only report what you can see, so ids cannot be probed), what it said (the snapshot kept as evidence with the report, so an edit or a delete
// does not erase it), whether it belongs to the romance mode (which moves it up the queue), and how to hide, remove or restore it.
//
//   hide     reversible: the thing disappears for everyone but staff (deletedAt/closedAt/isPublic/paused, with moderatedAt);
//   remove   final: as hide, and its text is blanked (the snapshot on the report and the action keeps the evidence for as long as they are kept);
//   restore  undoes a hide (a reversed action or an overturned appeal).

type Db = PrismaClient
type Tx = Prisma.TransactionClient

export { CONTENT_TARGETS, REPORT_TARGETS, USER_REPORTABLE_TARGETS } from './target-types'

const REMOVED = '[removed by a moderator]'

export interface ResolvedTarget {
  type: ReportTarget
  id: string
  /** The person who made it (the user, for USER). */
  ownerId: string
  romance: boolean
  snapshot: Record<string, unknown>
}

/** The thing, if it exists and `viewerId` could see it (null viewer: staff, who see everything). */
export async function resolveTarget(db: Db | Tx, type: ReportTarget, id: string, viewerId: string | null): Promise<ResolvedTarget | null> {
  const d = db as Db
  switch (type) {
    case 'USER': {
      const user = await d.user.findUnique({ where: { id }, select: { id: true, username: true, name: true, headline: true, bio: true, deletedAt: true } })
      if (!user || (viewerId && user.deletedAt)) return null
      return { type, id, ownerId: user.id, romance: false, snapshot: { username: user.username, name: user.name, headline: user.headline, bio: user.bio } }
    }
    case 'MESSAGE': {
      const message = await d.message.findUnique({ where: { id }, select: { senderId: true, content: true, conversationId: true, createdAt: true, conversation: { select: { match: { select: { connectionType: true } } } } } })
      if (!message) return null
      if (viewerId) {
        const member = await d.conversationMember.findUnique({ where: { userId_conversationId: { userId: viewerId, conversationId: message.conversationId } }, select: { id: true } })
        if (!member) return null
      }
      return { type, id, ownerId: message.senderId, romance: message.conversation.match?.connectionType === 'DATING', snapshot: { content: message.content, conversationId: message.conversationId, sentAt: message.createdAt } }
    }
    case 'SHIP_POST': {
      const post = await d.shipPost.findUnique({ where: { id } })
      if (!post) return null
      if (viewerId && !canView(post, await loadViewerScope(d, viewerId))) return null
      return { type, id, ownerId: post.authorId, romance: false, snapshot: { title: post.title, body: post.body, links: post.links } }
    }
    case 'COMMENT': {
      const comment = await d.comment.findUnique({ where: { id }, include: { post: true } })
      if (!comment) return null
      if (viewerId && !canView(comment.post, await loadViewerScope(d, viewerId))) return null
      return { type, id, ownerId: comment.authorId, romance: false, snapshot: { body: comment.body, postId: comment.postId } }
    }
    case 'SPARK': {
      const spark = await d.spark.findUnique({ where: { id }, select: { fromId: true, toId: true, opener: true, connectionType: true } })
      // Only the person sparked can see (and report) a spark.
      if (!spark || (viewerId && spark.toId !== viewerId)) return null
      return { type, id, ownerId: spark.fromId, romance: spark.connectionType === 'DATING', snapshot: { opener: spark.opener } }
    }
    case 'ROMANCE_PROFILE': {
      const profile = await d.romanceProfile.findUnique({ where: { id }, select: { userId: true, promptObsessed: true, promptBuild: true, promptWeekend: true } })
      if (!profile) return null
      if (viewerId && viewerId !== profile.userId) {
        // Somebody who was shown the profile (a drop) or is matched with them.
        const [a, b] = viewerId < profile.userId ? [viewerId, profile.userId] : [profile.userId, viewerId]
        const [shown, matched] = await Promise.all([
          d.romanceDrop.findFirst({ where: { userId: viewerId, candidateId: profile.userId }, select: { id: true } }),
          d.match.findFirst({ where: { userAId: a, userBId: b, connectionType: 'DATING' }, select: { id: true } }),
        ])
        if (!shown && !matched) return null
      }
      return { type, id, ownerId: profile.userId, romance: true, snapshot: { promptObsessed: profile.promptObsessed, promptBuild: profile.promptBuild, promptWeekend: profile.promptWeekend } }
    }
    case 'LFG_POST': {
      const post = await d.lfgPost.findUnique({ where: { id }, select: { authorId: true, note: true, hackathonId: true } })
      if (!post) return null
      return { type, id, ownerId: post.authorId, romance: false, snapshot: { note: post.note, hackathonId: post.hackathonId } }
    }
    case 'IDEA': {
      const idea = await d.teamIdea.findUnique({ where: { id }, select: { authorId: true, title: true, description: true, teamId: true } })
      if (!idea) return null
      if (viewerId) {
        const member = await d.teamMember.findUnique({ where: { userId_teamId: { userId: viewerId, teamId: idea.teamId } }, select: { id: true } })
        if (!member) return null
      }
      return { type, id, ownerId: idea.authorId, romance: false, snapshot: { title: idea.title, description: idea.description, teamId: idea.teamId } }
    }
    case 'EXTERNAL_HACKATHON': {
      const hackathon = await d.hackathon.findUnique({ where: { id }, select: { source: true, submittedById: true, name: true, externalUrl: true, description: true, isPublic: true } })
      if (!hackathon || hackathon.source !== 'EXTERNAL' || !hackathon.submittedById) return null
      if (viewerId && !hackathon.isPublic) return null
      return { type, id, ownerId: hackathon.submittedById, romance: false, snapshot: { name: hackathon.name, externalUrl: hackathon.externalUrl, description: hackathon.description.slice(0, 2000) } }
    }
    case 'EVIDENCE_CLAIM': {
      const claim = await d.githubRepoEvidence.findUnique({ where: { id }, select: { userId: true, repoGithubId: true, fullName: true, url: true, claimed: true, support: true, strength: true, authoredShare: true } })
      if (!claim || !claim.claimed) return null
      // Only somebody with authored work in the same repository can see (and dispute) another person's claim to it.
      if (viewerId && viewerId !== claim.userId) {
        const mine = await d.githubRepoEvidence.findUnique({ where: { userId_repoGithubId: { userId: viewerId, repoGithubId: claim.repoGithubId } }, select: { support: true, firstAuthoredAt: true } })
        if (!mine || mine.support !== 'SUPPORTED' || !mine.firstAuthoredAt) return null
      }
      return { type, id, ownerId: claim.userId, romance: false, snapshot: { repoGithubId: claim.repoGithubId, fullName: claim.fullName, url: claim.url, support: claim.support, strength: claim.strength, authoredShare: claim.authoredShare } }
    }
    case 'MEDIA': {
      const asset = await d.mediaAsset.findUnique({ where: { id }, select: { ownerId: true, purpose: true, key: true, sha256: true } })
      if (!asset || viewerId) return null
      return { type, id, ownerId: asset.ownerId, romance: asset.purpose === 'ROMANCE_PHOTO', snapshot: { purpose: asset.purpose, key: asset.key, sha256: asset.sha256 } }
    }
  }
}

export type ContentEffect = 'HIDE' | 'REMOVE' | 'RESTORE'

/** Applies a moderator's hide, remove or restore to a piece of content. Returns object-store keys to delete after the commit (removed photos). */
export async function applyContentEffect(tx: Tx, type: ReportTarget, id: string, effect: ContentEffect, now: Date): Promise<{ objectKeys: string[] }> {
  const hidden = effect === 'RESTORE' ? { moderatedAt: null } : { moderatedAt: now }
  switch (type) {
    case 'MESSAGE':
      await tx.message.updateMany({ where: { id }, data: { ...hidden, deletedAt: effect === 'RESTORE' ? null : now, ...(effect === 'REMOVE' ? { content: REMOVED } : {}) } })
      break
    case 'SHIP_POST':
      await tx.shipPost.updateMany({ where: { id }, data: { ...hidden, deletedAt: effect === 'RESTORE' ? null : now, ...(effect === 'REMOVE' ? { title: REMOVED, body: REMOVED, links: [], media: [] } : {}) } })
      break
    case 'COMMENT':
      await tx.comment.updateMany({ where: { id }, data: { ...hidden, deletedAt: effect === 'RESTORE' ? null : now, ...(effect === 'REMOVE' ? { body: REMOVED } : {}) } })
      break
    case 'SPARK':
      await tx.spark.updateMany({ where: { id }, data: { ...hidden, ...(effect === 'REMOVE' ? { opener: REMOVED } : {}) } })
      break
    case 'LFG_POST':
      await tx.lfgPost.updateMany({ where: { id }, data: { ...hidden, closedAt: effect === 'RESTORE' ? null : now, ...(effect === 'REMOVE' ? { note: REMOVED } : {}) } })
      break
    case 'IDEA':
      await tx.teamIdea.updateMany({ where: { id }, data: { ...hidden, ...(effect === 'REMOVE' ? { title: REMOVED, description: null } : {}) } })
      break
    case 'EXTERNAL_HACKATHON':
      await tx.hackathon.updateMany({ where: { id }, data: { ...hidden, isPublic: effect === 'RESTORE', ...(effect === 'REMOVE' ? { description: REMOVED } : {}) } })
      break
    case 'ROMANCE_PROFILE': {
      if (effect === 'REMOVE') {
        const profile = await tx.romanceProfile.findUnique({ where: { id }, select: { userId: true } })
        if (profile) return { objectKeys: (await purgeRomance(tx, profile.userId, now)).objectKeys }
        break
      }
      // A hidden profile stays paused, and its owner cannot unpause it until the hide is undone.
      await tx.romanceProfile.updateMany({ where: { id }, data: effect === 'HIDE' ? { paused: true, moderatedAt: now } : { moderatedAt: null } })
      break
    }
    case 'MEDIA': {
      const asset = await tx.mediaAsset.findUnique({ where: { id }, select: { key: true } })
      if (!asset) break
      if (effect === 'RESTORE') await tx.mediaAsset.updateMany({ where: { id }, data: { status: 'READY', scannedAt: now } })
      else {
        await tx.mediaAsset.updateMany({ where: { id }, data: { status: 'BLOCKED', scannedAt: now } })
        return { objectKeys: [asset.key] }
      }
      break
    }
    case 'EVIDENCE_CLAIM':
      // Hidden or removed alike: the claim stops counting and leaves the public passport, and is never deleted (its owner still sees it, with why).
      await tx.githubRepoEvidence.updateMany({ where: { id }, data: { moderatedAt: effect === 'RESTORE' ? null : now } })
      break
    case 'USER':
      break
  }
  return { objectKeys: [] }
}

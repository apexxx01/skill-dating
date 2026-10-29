import type { Prisma } from '@prisma/client'
import { recomputePropsScore } from '@/lib/integrity/collusion-job'
import { purgeRomance } from '@/lib/romance/lifecycle'
import { DATA_INVENTORY } from './inventory'

// What deleting an account does to everything else (the User row itself is anonymised by tombstoneClerkUser in src/lib/user-sync.ts). Driven by the data
// inventory (inventory.ts): every DELETE and SET_NULL rule is applied generically, and the SCRUB and CUSTOM rules have their steps here. Runs inside the
// deletion's transaction; returns the bucket keys to remove once it has committed.

type Tx = Prisma.TransactionClient

const DELETED_TEXT = '[deleted]'
const lowerFirst = (name: string) => name.charAt(0).toLowerCase() + name.slice(1)

/** The steps of the SCRUB and CUSTOM rules, in the order they must run (before the generic deletes, which they read before). */
async function customSteps(tx: Tx, userId: string, now: Date): Promise<string[]> {
  // The romance mode: profile, filters, photos (rows), drops, pending sparks, duos, reveal state; its open matches end.
  const romance = await purgeRomance(tx, userId, now)

  // Duos the person is in are dissolved (a match ending does it too, but a Duo can outlive its match).
  await tx.duo.updateMany({ where: { status: { not: 'DISSOLVED' }, OR: [{ userAId: userId }, { userBId: userId }] }, data: { status: 'DISSOLVED', dissolvedAt: now, dissolvedById: userId } })

  // Other open matches end, silently; the rows stay for the other person's history.
  await tx.match.updateMany({ where: { endedAt: null, OR: [{ userAId: userId }, { userBId: userId }] }, data: { endedAt: now, endedById: userId, endReason: 'UNMATCHED' } })

  // Uploads: rows go now, objects after the commit.
  const media = await tx.mediaAsset.findMany({ where: { ownerId: userId }, select: { key: true } })
  await tx.mediaAsset.deleteMany({ where: { ownerId: userId } })

  // Posts and comments are hidden and blanked: threads under them keep their shape. The person comes off other people's posts as a co-author.
  await tx.shipPost.updateMany({ where: { authorId: userId }, data: { deletedAt: now, title: DELETED_TEXT, body: DELETED_TEXT, links: [], media: [], coAuthorIds: [] } })
  await tx.$executeRaw`UPDATE "ShipPost" SET "coAuthorIds" = array_remove("coAuthorIds", ${userId}) WHERE ${userId} = ANY("coAuthorIds")`
  await tx.comment.updateMany({ where: { authorId: userId }, data: { deletedAt: now, body: DELETED_TEXT } })

  // Props given go, and the posts' scores and counts follow.
  const props = await tx.prop.findMany({ where: { userId }, select: { postId: true } })
  await tx.prop.deleteMany({ where: { userId } })
  const postIds = [...new Set(props.map((p) => p.postId))]
  await recomputePropsScore(tx, postIds)
  for (const postId of postIds) await tx.$executeRaw`UPDATE "ShipPost" SET "propsCount" = (SELECT COUNT(*) FROM "Prop" WHERE "postId" = ${postId}) WHERE "id" = ${postId}`

  // Reviews given stay (teammates' reliability depends on them) without their private note.
  await tx.peerReview.updateMany({ where: { reviewerId: userId }, data: { note: null } })

  // Export files: rows now, objects after the commit.
  const exports = await tx.dataExport.findMany({ where: { userId, storageKey: { not: null } }, select: { storageKey: true } })
  await tx.dataExport.deleteMany({ where: { userId } })

  // Receipts are revoked rather than deleted, so a copy of the link answers 410 Gone: the facts, the source and the signature go, the id stays.
  await tx.$executeRaw`UPDATE "EvidenceReceipt" SET "status" = 'REVOKED', "revokedAt" = ${now}, "facts" = '{}'::jsonb, "sourceRef" = 'revoked:' || "id", "sourceUrl" = '', "payloadHash" = '', "signature" = NULL, "kid" = NULL, "updatedAt" = ${now} WHERE "userId" = ${userId}`

  // Early-access allowlists.
  await tx.$executeRaw`UPDATE "FeatureFlag" SET "allowUserIds" = array_remove("allowUserIds", ${userId}) WHERE ${userId} = ANY("allowUserIds")`

  return [...romance.objectKeys, ...media.map((m) => m.key), ...exports.map((e) => e.storageKey!)]
}

/** Applies the inventory's rules for one account. Returns the object-store keys to delete after the commit. */
export async function deleteAccountData(tx: Tx, userId: string, now: Date = new Date()): Promise<string[]> {
  const objectKeys = await customSteps(tx, userId, now)
  for (const [name, entry] of Object.entries(DATA_INVENTORY)) {
    const model = name.split('_')[0]
    if (model === 'User') continue
    const delegate = (tx as unknown as Record<string, { deleteMany(args: unknown): Promise<unknown>; updateMany(args: unknown): Promise<unknown> }>)[lowerFirst(model)]
    for (const [field, rule] of Object.entries(entry.fields)) {
      if (rule === 'DELETE') await delegate.deleteMany({ where: { [field]: userId } })
      else if (rule === 'SET_NULL') await delegate.updateMany({ where: { [field]: userId }, data: { [field]: null } })
    }
  }
  return objectKeys
}

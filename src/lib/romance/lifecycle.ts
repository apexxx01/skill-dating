import type { Prisma, PrismaClient } from '@prisma/client'
import { endMatchIn } from '@/lib/matching/matches'
import type { Storage } from '@/lib/infra/storage'
import { log } from '@/lib/log'

// Leaving the romance mode, and being removed from it. One function does the removal for all three reasons it happens:
//
//   - the person leaves (DELETE /api/romance/profile),
//   - the person turns out to be a minor (an admin correction to 16 or 17: the mode is 18+),
//   - the account is deleted.
//
// It removes the profile (its photos with it), the photos' uploads, every drop for or of the person, and every romance spark they sent or are waiting on, and ENDS their open romance
// matches (final, silent, with the conversation closed for both). It does not touch anything professional. The objects in the bucket cannot be deleted inside a database
// transaction, so the keys are returned and removeObjects() deletes them afterwards (and a failure leaves them to be noticed by the storage lifecycle, never to be shown to anyone: the rows that
// pointed to them are gone).

type Tx = Prisma.TransactionClient

export interface RomanceRemoval {
  /** Whether the person had a romance profile. */
  hadProfile: boolean
  matchesEnded: number
  /** The keys of the photos' objects to delete once the transaction has committed. */
  objectKeys: string[]
}

export async function purgeRomance(tx: Tx, userId: string, now: Date = new Date()): Promise<RomanceRemoval> {
  const profile = await tx.romanceProfile.findUnique({ where: { userId }, select: { id: true } })

  const open = await tx.match.findMany({ where: { connectionType: 'DATING', endedAt: null, OR: [{ userAId: userId }, { userBId: userId }] } })
  let matchesEnded = 0
  for (const match of open) if (await endMatchIn(tx, match, userId, 'UNMATCHED', now)) matchesEnded += 1

  await tx.romanceDrop.deleteMany({ where: { OR: [{ userId }, { candidateId: userId }] } })
  await tx.spark.deleteMany({ where: { connectionType: 'DATING', status: 'PENDING', OR: [{ fromId: userId }, { toId: userId }] } })

  const photos = await tx.mediaAsset.findMany({ where: { ownerId: userId, purpose: 'ROMANCE_PHOTO' }, select: { id: true, key: true } })
  await tx.mediaAsset.deleteMany({ where: { id: { in: photos.map((photo) => photo.id) } } })
  if (profile) await tx.romanceProfile.delete({ where: { id: profile.id } })

  return { hadProfile: profile !== null, matchesEnded, objectKeys: photos.map((photo) => photo.key) }
}

/** Deletes objects from the bucket, best effort. */
export async function removeObjects(storage: Pick<Storage, 'remove'>, keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    try {
      await storage.remove(key)
    } catch (error) {
      log.warn('could not delete a romance photo from storage', { error, key })
    }
  }
}

/** Leaves the mode: removes everything, then the objects. */
export async function leaveRomance(db: PrismaClient, storage: Pick<Storage, 'remove'>, userId: string, now: Date = new Date()): Promise<RomanceRemoval> {
  const removal = await db.$transaction((tx) => purgeRomance(tx, userId, now), { timeout: 15_000 })
  await removeObjects(storage, removal.objectKeys)
  return removal
}

/** The hook for an admin correction that makes a person a minor (src/lib/birth-date-admin.ts): inside its transaction, the objects left to the lifecycle of the bucket. */
export async function purgeRomanceForMinor(tx: Tx, userId: string): Promise<void> {
  await purgeRomance(tx, userId)
}

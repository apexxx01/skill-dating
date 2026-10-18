import type { Prisma, PrismaClient } from '@prisma/client'
import type { ErrorCode } from '@/lib/api/errors'
import { datingFactsSelect, datingRefusal, datingStatus, type DatingStatus } from '@/lib/matching/profile'
import { mediaUrl } from '@/lib/media-assets'
import type { Storage } from '@/lib/infra/storage'
import { ROMANCE_MODE_LABEL, ROMANCE_OPTIONS } from './config'
import { profileColumns, scopeProblems, toOwnProfile, type OwnRomanceProfile, type RomanceProfileInput, type StoredRomanceProfile } from './profile'

// Reading and saving a person's own romance profile. The gate (18 or older, a verified email, a phone or GitHub, a date of birth on file) is the one in
// src/lib/matching/dating.ts, applied before anything is saved and again by every surface that shows or matches people.

type Db = PrismaClient | Prisma.TransactionClient

export interface OwnPhoto {
  id: string
  position: number
  blurHash: string | null
  url: string
  width: number
  height: number
}

export interface OwnRomanceView {
  /** The mode's name as people read it (ROMANCE_MODE_LABEL). */
  modeLabel: string
  exists: boolean
  profile: OwnRomanceProfile | null
  photos: OwnPhoto[]
  /** Whether they may use the mode, and what stands in the way. */
  eligibility: DatingStatus
  options: typeof ROMANCE_OPTIONS
}

export async function loadOwnPhotos(db: Db, storage: Pick<Storage, 'publicUrl' | 'signedReadUrl'>, profileId: string): Promise<OwnPhoto[]> {
  const rows = await db.romancePhoto.findMany({ where: { profileId }, orderBy: { position: 'asc' }, include: { asset: { select: { key: true, width: true, height: true } } } })
  const photos: OwnPhoto[] = []
  for (const row of rows) {
    photos.push({ id: row.id, position: row.position, blurHash: row.blurHash, url: await mediaUrl(storage as Storage, row.asset.key), width: row.asset.width, height: row.asset.height })
  }
  return photos
}

export async function loadOwnRomance(db: Db, storage: Pick<Storage, 'publicUrl' | 'signedReadUrl'>, userId: string, now: Date = new Date()): Promise<OwnRomanceView> {
  const [row, facts] = await Promise.all([db.romanceProfile.findUnique({ where: { userId } }), db.user.findUnique({ where: { id: userId }, select: datingFactsSelect })])
  const photos = row ? await loadOwnPhotos(db, storage, row.id).catch(() => []) : []
  return {
    modeLabel: ROMANCE_MODE_LABEL,
    exists: row !== null,
    profile: row ? toOwnProfile(row as unknown as StoredRomanceProfile) : null,
    photos,
    eligibility: datingStatus(facts, now),
    options: ROMANCE_OPTIONS,
  }
}

export type SaveResult = { ok: true } | { ok: false; code: ErrorCode; details?: unknown }

/** Saves (creates or replaces) the profile after the gate and the place check. */
export async function saveRomanceProfile(db: PrismaClient, userId: string, input: RomanceProfileInput, now: Date = new Date()): Promise<SaveResult> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { ...datingFactsSelect, deletedAt: true, profile: { select: { cityKey: true, countryCode: true } } } })
  if (!user || user.deletedAt) return { ok: false, code: 'USER_NOT_FOUND' }

  const status = datingStatus(user, now)
  const refusal = datingRefusal(status.blockers)
  if (refusal) return { ok: false, code: refusal, details: { blockers: status.blockers } }

  const problems = scopeProblems(input, { cityKey: user.profile?.cityKey ?? null, countryCode: user.profile?.countryCode ?? null })
  if (problems) return { ok: false, code: 'VALIDATION_FAILED', details: problems }

  const columns = profileColumns(input)
  await db.romanceProfile.upsert({ where: { userId }, create: { userId, ...columns }, update: columns })
  return { ok: true }
}

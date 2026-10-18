import type { PrismaClient } from '@prisma/client'
import { z } from 'zod'
import type { ErrorCode } from '@/lib/api/errors'
import type { Storage } from '@/lib/infra/storage'
import { readyAssets } from '@/lib/media-assets'
import { removeObjects } from './lifecycle'
import { ROMANCE_CONFIG } from './config'

// A person's own romance photos. Each is a confirmed upload (src/lib/media-assets.ts, purpose ROMANCE_PHOTO) attached to the profile, in an order, with an optional BlurHash the
// client computed to show in place of the photo to anybody who may not see it yet. A person's photos are returned to them only; everybody else gets the placeholder until a mutual
// reveal (src/lib/romance/reveal.ts).

type Db = PrismaClient

// BlurHash alphabet (base 83) and a sane length.
export const BLUR_HASH = /^[0-9A-Za-z#$%*+,\-.:;=?@[\]^_{|}~]{6,100}$/

export const addPhotoSchema = z.object({ assetId: z.string().min(1).max(64), blurHash: z.string().regex(BLUR_HASH, 'A BlurHash string').nullable().default(null) }).strict()

export type PhotoResult = { ok: true; id: string; position: number } | { ok: false; code: ErrorCode; details?: unknown }

export async function addPhoto(db: Db, userId: string, input: z.infer<typeof addPhotoSchema>): Promise<PhotoResult> {
  const profile = await db.romanceProfile.findUnique({ where: { userId }, select: { id: true } })
  if (!profile) return { ok: false, code: 'ROMANCE_PROFILE_REQUIRED' }
  const [asset] = await readyAssets(db, userId, 'ROMANCE_PHOTO', [input.assetId])
  if (!asset) return { ok: false, code: 'MEDIA_NOT_FOUND' }
  try {
    return await db.$transaction(async (tx) => {
      const count = await tx.romancePhoto.count({ where: { profileId: profile.id } })
      if (count >= ROMANCE_CONFIG.photos.max) return { ok: false as const, code: 'ROMANCE_PHOTO_LIMIT' as ErrorCode }
      const photo = await tx.romancePhoto.create({ data: { profileId: profile.id, assetId: asset.id, position: count, blurHash: input.blurHash } })
      return { ok: true as const, id: photo.id, position: photo.position }
    })
  } catch (error) {
    // The same upload attached twice (assetId is unique).
    if ((error as { code?: string }).code === 'P2002') return { ok: false, code: 'VALIDATION_FAILED', details: { assetId: ['Already one of your photos'] } }
    throw error
  }
}

/** Removes one of the caller's photos, with its upload, and closes the gap in the order. */
export async function removePhoto(db: Db, storage: Pick<Storage, 'remove'>, userId: string, photoId: string): Promise<boolean> {
  const photo = await db.romancePhoto.findUnique({ where: { id: photoId }, include: { profile: { select: { userId: true, id: true } }, asset: { select: { id: true, key: true } } } })
  if (!photo || photo.profile.userId !== userId) return false
  await db.$transaction(async (tx) => {
    await tx.mediaAsset.delete({ where: { id: photo.asset.id } })
    const rest = await tx.romancePhoto.findMany({ where: { profileId: photo.profile.id }, orderBy: { position: 'asc' }, select: { id: true } })
    for (const [position, row] of rest.entries()) await tx.romancePhoto.update({ where: { id: row.id }, data: { position } })
  })
  await removeObjects(storage, [photo.asset.key])
  return true
}

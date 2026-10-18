import { Prisma, type MediaAsset, type PrismaClient } from '@prisma/client'
import type { ErrorCode } from '@/lib/api/errors'
import { log } from '@/lib/log'
import { StorageUnavailableError, type PresignedUpload, type Storage } from '@/lib/infra/storage'
import { checkDeclaration, MEDIA_LIMITS, objectKey, objectMatches, type MediaDeclaration, type MediaPurpose } from './media'

// The life of an upload: declare, upload, confirm.
//
//   1. requestUpload   the person declares a file (type, size, dimensions, SHA-256). A declaration that breaks a rule is refused here, before anything is signed. If
//                      they already have a READY file with the same hash and purpose, that is returned and nothing is uploaded again (the content-hash dedupe). Otherwise a
//                      PENDING row is made and a presigned PUT for exactly that key and content type is returned.
//   2. (the client PUTs the bytes straight to the bucket)
//   3. completeUpload  the server looks at the real object (size and type) and compares it with the declaration. A match makes the asset READY; a mismatch REJECTs it and
//                      deletes the object, so a file bigger or of another type than declared never gets used.
//
// A READY asset is what posts and romance photos refer to. Abandoned PENDING assets are cleaned up by the job `media/cleanup`.

type Db = PrismaClient | Prisma.TransactionClient

export type MediaFailure = { ok: false; code: ErrorCode; details?: unknown }
const fail = (code: ErrorCode, details?: unknown): MediaFailure => ({ ok: false, code, ...(details !== undefined ? { details } : {}) })

export type RequestUploadResult = { ok: true; asset: MediaAsset; upload: PresignedUpload | null; duplicate: boolean } | MediaFailure

export async function requestUpload(
  db: PrismaClient,
  storage: Storage,
  ownerId: string,
  declaration: MediaDeclaration,
  options: { origin?: string; now?: Date } = {}
): Promise<RequestUploadResult> {
  const check = checkDeclaration(declaration)
  if (!check.ok || !check.type || !check.extension) return fail('MEDIA_INVALID', { problems: check.problems })

  // The same file already there and checked: nothing to upload.
  const existing = await db.mediaAsset.findUnique({ where: { ownerId_purpose_sha256: { ownerId, purpose: declaration.purpose, sha256: declaration.sha256 } } })
  if (existing?.status === 'READY') return { ok: true, asset: existing, upload: null, duplicate: true }

  const key = objectKey(declaration.purpose, ownerId, declaration.sha256, check.extension)
  try {
    if (existing) {
      // An unfinished or rejected declaration of the same file: the new declaration replaces it (the numbers may differ, and a rejected file may be tried again).
      const asset = await db.mediaAsset.update({
        where: { id: existing.id },
        data: {
          kind: check.type,
          key,
          contentType: declaration.contentType.toLowerCase(),
          bytes: declaration.bytes,
          width: declaration.width,
          height: declaration.height,
          durationMs: declaration.durationMs ?? null,
          status: 'PENDING',
          confirmedAt: null,
        },
      })
      return { ok: true, asset, upload: await storage.presignUpload({ key, contentType: asset.contentType, origin: options.origin }), duplicate: false }
    }

    const pending = await db.mediaAsset.count({ where: { ownerId, status: 'PENDING' } })
    if (pending >= MEDIA_LIMITS.maxPendingPerOwner) return fail('MEDIA_PENDING_LIMIT')

    const asset = await db.mediaAsset.create({
      data: {
        ownerId,
        purpose: declaration.purpose,
        kind: check.type,
        key,
        contentType: declaration.contentType.toLowerCase(),
        bytes: declaration.bytes,
        width: declaration.width,
        height: declaration.height,
        durationMs: declaration.durationMs ?? null,
        sha256: declaration.sha256,
        createdAt: options.now,
      },
    })
    return { ok: true, asset, upload: await storage.presignUpload({ key, contentType: asset.contentType, origin: options.origin }), duplicate: false }
  } catch (error) {
    if (error instanceof StorageUnavailableError) return fail('STORAGE_UNAVAILABLE')
    // Two requests declaring the same new file at once: the other one made the row; hand back what is there.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const raced = await db.mediaAsset.findUnique({ where: { ownerId_purpose_sha256: { ownerId, purpose: declaration.purpose, sha256: declaration.sha256 } } })
      if (raced) return { ok: true, asset: raced, upload: raced.status === 'READY' ? null : await storage.presignUpload({ key: raced.key, contentType: raced.contentType, origin: options.origin }), duplicate: raced.status === 'READY' }
    }
    throw error
  }
}

export type CompleteUploadResult = { ok: true; asset: MediaAsset } | MediaFailure

export async function completeUpload(db: PrismaClient, storage: Storage, ownerId: string, assetId: string, now: Date = new Date()): Promise<CompleteUploadResult> {
  const asset = await db.mediaAsset.findUnique({ where: { id: assetId } })
  // Somebody else's upload does not exist as far as you are concerned.
  if (!asset || asset.ownerId !== ownerId) return fail('MEDIA_NOT_FOUND')
  if (asset.status === 'READY') return { ok: true, asset }

  try {
    const object = await storage.head(asset.key)
    if (!object) return fail('MEDIA_NOT_UPLOADED')
    if (!objectMatches({ bytes: asset.bytes, contentType: asset.contentType }, object)) {
      await db.mediaAsset.update({ where: { id: asset.id }, data: { status: 'REJECTED' } })
      await storage.remove(asset.key).catch((error) => log.warn('could not remove a rejected upload', { error, key: asset.key }))
      return fail('MEDIA_MISMATCH', { declared: { bytes: asset.bytes, contentType: asset.contentType }, found: { bytes: object.size, contentType: object.contentType } })
    }
    const ready = await db.mediaAsset.update({ where: { id: asset.id }, data: { status: 'READY', confirmedAt: now } })
    return { ok: true, asset: ready }
  } catch (error) {
    if (error instanceof StorageUnavailableError) return fail('STORAGE_UNAVAILABLE')
    throw error
  }
}

/** What a client is told about a ready asset. The URL is permanent when the bucket is public, otherwise a short-lived signed one. */
export interface MediaView {
  id: string
  type: 'IMAGE' | 'GIF' | 'VIDEO'
  url: string
  width: number
  height: number
  durationMs: number | null
}

export async function mediaUrl(storage: Storage, key: string): Promise<string> {
  return storage.publicUrl(key) ?? (await storage.signedReadUrl(key))
}

export async function toMediaView(storage: Storage, asset: Pick<MediaAsset, 'id' | 'kind' | 'key' | 'width' | 'height' | 'durationMs'>): Promise<MediaView> {
  return { id: asset.id, type: asset.kind, url: await mediaUrl(storage, asset.key), width: asset.width, height: asset.height, durationMs: asset.durationMs }
}

/** The READY assets of `ownerId` for `purpose` among `ids`, in the order asked. Anything else (somebody else's, not ready, another purpose) is simply missing from the answer. */
export async function readyAssets(db: Db, ownerId: string, purpose: MediaPurpose, ids: readonly string[]): Promise<MediaAsset[]> {
  if (ids.length === 0) return []
  const rows = await db.mediaAsset.findMany({ where: { id: { in: [...ids] }, ownerId, purpose, status: 'READY' } })
  const byId = new Map(rows.map((row) => [row.id, row]))
  return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
}

/** Removes uploads nobody finished (PENDING for more than a day) and rejected ones, with their objects. */
export async function cleanupAbandonedUploads(db: PrismaClient, storage: Storage, now: Date = new Date(), olderThanHours = 24): Promise<{ removed: number }> {
  const cutoff = new Date(now.getTime() - olderThanHours * 3_600_000)
  const stale = await db.mediaAsset.findMany({ where: { status: { in: ['PENDING', 'REJECTED'] }, createdAt: { lt: cutoff } }, select: { id: true, key: true }, take: 500 })
  let removed = 0
  for (const asset of stale) {
    try {
      await storage.remove(asset.key)
      await db.mediaAsset.delete({ where: { id: asset.id } })
      removed += 1
    } catch (error) {
      log.warn('could not clean up an abandoned upload', { error, assetId: asset.id })
    }
  }
  return { removed }
}

export async function runMediaCleanupJob(): Promise<{ removed: number }> {
  const { prisma } = await import('@/lib/prisma')
  const { getStorage } = await import('@/lib/infra/storage')
  return cleanupAbandonedUploads(prisma, getStorage())
}

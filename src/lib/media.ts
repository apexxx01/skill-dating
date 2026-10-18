import { z } from 'zod'

// What may be uploaded, and the rules each kind must meet, as pure data and one validator. A person declares a file (type, size, dimensions, hash)
// BEFORE it is uploaded; the server checks the declaration here, hands out a presigned URL only for a declaration that passes (src/lib/infra/storage.ts),
// and checks the real object against it once it is uploaded (src/lib/media-assets.ts). Nothing is trusted from the declaration alone.

export const MEDIA_PURPOSES = ['POST_MEDIA', 'ROMANCE_PHOTO'] as const
export type MediaPurpose = (typeof MEDIA_PURPOSES)[number]

export const MEDIA_TYPES = ['IMAGE', 'GIF', 'VIDEO'] as const
export type MediaType = (typeof MEDIA_TYPES)[number]

interface TypeRule {
  type: MediaType
  extension: string
  maxBytes: number
}

const MB = 1024 * 1024

export const ALLOWED_CONTENT_TYPES: Record<string, TypeRule> = {
  'image/jpeg': { type: 'IMAGE', extension: 'jpg', maxBytes: 10 * MB },
  'image/png': { type: 'IMAGE', extension: 'png', maxBytes: 10 * MB },
  'image/webp': { type: 'IMAGE', extension: 'webp', maxBytes: 10 * MB },
  'image/gif': { type: 'GIF', extension: 'gif', maxBytes: 15 * MB },
  'video/mp4': { type: 'VIDEO', extension: 'mp4', maxBytes: 100 * MB },
  'video/webm': { type: 'VIDEO', extension: 'webm', maxBytes: 100 * MB },
}

export const MEDIA_LIMITS = {
  /** Smallest and largest side, in pixels. */
  minSide: 16,
  maxSide: 8000,
  maxVideoDurationMs: 120_000,
  /** What a post may carry. */
  maxPerPost: 6,
  /** A person's unfinished uploads at any time (so presigning cannot be used to fill the bucket). */
  maxPendingPerOwner: 20,
} as const

/** What a romance photo must meet, on top of the rules for any image. The romance mode's own config (src/lib/romance/config.ts) takes these as its photo limits. */
export const ROMANCE_PHOTO_LIMITS = { max: 6, maxBytes: 8 * MB, minWidth: 400, minHeight: 400, maxDimension: 8000 } as const

export const SHA256_PATTERN = /^[a-f0-9]{64}$/

export const mediaDeclarationSchema = z
  .object({
    purpose: z.enum(MEDIA_PURPOSES),
    contentType: z.string().max(100),
    bytes: z.number().int().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    durationMs: z.number().int().positive().optional(),
    sha256: z.string().regex(SHA256_PATTERN, 'A lower-case hex SHA-256 of the file'),
  })
  .strict()

export type MediaDeclaration = z.infer<typeof mediaDeclarationSchema>

export type MediaProblem = 'TYPE_NOT_ALLOWED' | 'TOO_LARGE' | 'DIMENSIONS_OUT_OF_RANGE' | 'TOO_SMALL' | 'DURATION_REQUIRED' | 'DURATION_TOO_LONG' | 'DURATION_NOT_ALLOWED' | 'PURPOSE_TYPE_MISMATCH'

export interface MediaCheck {
  ok: boolean
  type?: MediaType
  extension?: string
  problems: { problem: MediaProblem; message: string }[]
}

/** The rules for one declaration. Romance photos are stricter: still images only, big enough to see a face, and smaller files. */
export function checkDeclaration(declaration: MediaDeclaration): MediaCheck {
  const problems: MediaCheck['problems'] = []
  const rule = ALLOWED_CONTENT_TYPES[declaration.contentType.toLowerCase()]
  if (!rule) return { ok: false, problems: [{ problem: 'TYPE_NOT_ALLOWED', message: 'Use JPEG, PNG, WebP, GIF, MP4 or WebM' }] }

  if (declaration.purpose === 'ROMANCE_PHOTO' && rule.type !== 'IMAGE') problems.push({ problem: 'PURPOSE_TYPE_MISMATCH', message: 'A profile photo must be a JPEG, PNG or WebP image' })

  const maxBytes = declaration.purpose === 'ROMANCE_PHOTO' ? Math.min(rule.maxBytes, ROMANCE_PHOTO_LIMITS.maxBytes) : rule.maxBytes
  if (declaration.bytes > maxBytes) problems.push({ problem: 'TOO_LARGE', message: `At most ${Math.floor(maxBytes / MB)} MB` })

  const { minSide, maxSide } = MEDIA_LIMITS
  if (declaration.width > maxSide || declaration.height > maxSide || declaration.width < minSide || declaration.height < minSide) {
    problems.push({ problem: 'DIMENSIONS_OUT_OF_RANGE', message: `Each side must be ${minSide} to ${maxSide} pixels` })
  }
  if (declaration.purpose === 'ROMANCE_PHOTO' && (declaration.width < ROMANCE_PHOTO_LIMITS.minWidth || declaration.height < ROMANCE_PHOTO_LIMITS.minHeight)) {
    problems.push({ problem: 'TOO_SMALL', message: `At least ${ROMANCE_PHOTO_LIMITS.minWidth} by ${ROMANCE_PHOTO_LIMITS.minHeight} pixels` })
  }

  if (rule.type === 'VIDEO') {
    if (declaration.durationMs === undefined) problems.push({ problem: 'DURATION_REQUIRED', message: 'Say how long the video is' })
    else if (declaration.durationMs > MEDIA_LIMITS.maxVideoDurationMs) problems.push({ problem: 'DURATION_TOO_LONG', message: `At most ${MEDIA_LIMITS.maxVideoDurationMs / 1000} seconds` })
  } else if (declaration.durationMs !== undefined) {
    problems.push({ problem: 'DURATION_NOT_ALLOWED', message: 'Only a video has a duration' })
  }
  return { ok: problems.length === 0, type: rule.type, extension: rule.extension, problems }
}

/** Where an object lives. Content-addressed per owner and purpose, so the same file uploaded twice is one object. */
export function objectKey(purpose: MediaPurpose, ownerId: string, sha256: string, extension: string): string {
  const folder = purpose === 'ROMANCE_PHOTO' ? 'romance' : 'posts'
  return `${folder}/${ownerId}/${sha256}.${extension}`
}

/** Whether a stored object's real size and type still match what was declared. */
export function objectMatches(declared: { bytes: number; contentType: string }, actual: { size: number; contentType: string | null }): boolean {
  if (actual.size !== declared.bytes) return false
  return actual.contentType === null || actual.contentType.split(';')[0].trim().toLowerCase() === declared.contentType.toLowerCase()
}

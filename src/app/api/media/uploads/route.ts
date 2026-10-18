import { NextRequest } from 'next/server'
import { withAuth, validateBody, createApiResponse, createApiError } from '@/lib/api/handler'
import { getStorage } from '@/lib/infra/storage'
import { mediaDeclarationSchema } from '@/lib/media'
import { requestUpload, toMediaView } from '@/lib/media-assets'

// POST /api/media/uploads  body: { purpose, contentType, bytes, width, height, durationMs?, sha256 }
//
// Declares a file before uploading it. A declaration that breaks a rule (type, size, dimensions, duration) is refused with the problems listed; one that passes gets a
// presigned URL to PUT the bytes to, with the headers to send. A file the caller already uploaded and confirmed (same SHA-256, same purpose) is not uploaded again:
// the answer is `{ duplicate: true, upload: null }` and the existing asset. After the PUT, call POST /api/media/{id}/complete.
export const POST = withAuth(async (request: NextRequest, { prisma, user }) => {
  const body = await validateBody(mediaDeclarationSchema)(request)
  if (body instanceof Response) return body

  const result = await requestUpload(prisma, getStorage(), user.id, body.data, { origin: new URL(request.url).origin })
  if (!result.ok) return createApiError(result.code, { details: result.details })

  const asset = await toMediaView(getStorage(), result.asset).catch(() => null)
  return createApiResponse(
    {
      asset: { id: result.asset.id, purpose: result.asset.purpose, status: result.asset.status, type: result.asset.kind, width: result.asset.width, height: result.asset.height, durationMs: result.asset.durationMs, ...(asset && result.asset.status === 'READY' ? { url: asset.url } : {}) },
      upload: result.upload ? { method: result.upload.method, url: result.upload.url, headers: result.upload.headers, expiresAt: result.upload.expiresAt.toISOString() } : null,
      duplicate: result.duplicate,
    },
    result.duplicate ? 200 : 201
  )
}, { idempotent: true, rateLimit: { windowMs: 60000, maxRequests: 30, keyPrefix: 'media:declare' } })

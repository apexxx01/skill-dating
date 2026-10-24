import { z } from 'zod'

// The request schemas of users/me/avatar, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

// PUT /api/users/me/avatar { mediaId }: uses an uploaded AVATAR (POST /api/media/uploads with purpose AVATAR, then complete) as the profile picture.
// Only a READY asset can be used, which for an avatar means the media scanner passed it (or a moderator approved it); while it is SCANNING or IN_REVIEW
// it is "not found". The picture is served from the bucket's public address, so this needs STORAGE_PUBLIC_BASE_URL (503 STORAGE_UNAVAILABLE without).
// DELETE removes the picture.
export const bodySchema = z.object({ mediaId: z.string().min(1).max(64) }).strict()

import { z } from 'zod'

// The request schemas of invites/redeem, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,
// src/lib/openapi) reads these.

// POST /api/invites/redeem { code }: joins with an invite code, once, in the first 14 days of the account. (A sign-up that carries the code in the Clerk user's unsafeMetadata.inviteCode
// is attributed automatically; this is for the pages that cannot.) The answer does not say whether the invite will count: that is decided when the invitee has got started.
export const bodySchema = z.object({ code: z.string().trim().min(4).max(40) }).strict()

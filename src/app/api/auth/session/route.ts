import { NextRequest, NextResponse } from 'next/server'
import { toSession } from '@/lib/auth'
import { authenticate } from '@/lib/session'

// Compatibility for the frozen frontend: `useSession()` from next-auth/react polls
// this path and expects `{ user, expires }` or `null`. It is answered from the
// Clerk session and carries the LOCAL user id. Delete it once the UI moves to
// Clerk's hooks (see docs/AUTH_MIGRATION.md).
export async function GET(request: NextRequest) {
  const session = toSession(await authenticate(request.headers))
  return NextResponse.json(session, { headers: { 'Cache-Control': 'no-store' } })
}

import type { NextRequest } from 'next/server'
import { handlers } from '@/lib/legacy-auth'
import { throttleCredentialsLogin } from '@/lib/login-throttle'

export const GET = handlers.GET

export async function POST(request: NextRequest) {
  if (new URL(request.url).pathname.endsWith('/callback/credentials')) {
    const limited = await throttleCredentialsLogin(request)
    if (limited) return limited
  }
  return handlers.POST(request)
}

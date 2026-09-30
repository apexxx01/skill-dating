import { clerkMiddleware } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// UX redirects only. This is NOT a security boundary: Next 14.1.0 lets a client
// skip middleware altogether (CVE-2025-29927), so every API route verifies the
// session token itself in withAuth, and server components call auth(). Nothing
// here is trusted by them.

const protectedRoutes = [
  '/dashboard',
  '/profile/edit',
  '/projects/new',
  '/teams/new',
  '/hackathons/new',
  '/messages',
  '/notifications',
  '/settings',
  '/onboarding',
]

const authRoutes = [
  '/signin',
  '/signup',
  '/error',
]

// Same live check used from both directions: /onboarding redirects away once
// this is true, every other protected route redirects here while it's
// false. One source of truth, no duplicated "what counts as onboarded" logic.
// Asks /api/users/me, which answers with the caller's LOCAL profile.
async function isOnboardingComplete(request: NextRequest): Promise<boolean> {
  try {
    const headers: Record<string, string> = { cookie: request.headers.get('cookie') || '' }
    const authorization = request.headers.get('authorization')
    if (authorization) headers.authorization = authorization
    const response = await fetch(`${request.nextUrl.origin}/api/users/me`, { headers })
    if (!response.ok) return false
    const me = await response.json()
    return Boolean(me?.onboardingComplete)
  } catch {
    return false
  }
}

export default clerkMiddleware(async (auth, request: NextRequest) => {
  const { userId } = await auth()
  const signedIn = Boolean(userId)
  const { pathname } = request.nextUrl

  const isProtectedRoute = protectedRoutes.some(route => pathname.startsWith(route))
  const isAuthRoute = authRoutes.some(route => pathname.startsWith(route))

  if (isProtectedRoute && !signedIn) {
    const signInUrl = new URL('/signin', request.url)
    signInUrl.searchParams.set('callbackUrl', pathname)
    return NextResponse.redirect(signInUrl)
  }

  if (isAuthRoute && signedIn) {
    return NextResponse.redirect(new URL('/dashboard', request.url))
  }

  if (pathname === '/onboarding' && signedIn) {
    if (await isOnboardingComplete(request)) {
      return NextResponse.redirect(new URL('/dashboard', request.url))
    }
  }

  if (isProtectedRoute && pathname !== '/onboarding' && signedIn) {
    if (!(await isOnboardingComplete(request))) {
      return NextResponse.redirect(new URL('/onboarding', request.url))
    }
  }

  return NextResponse.next()
})

// Page routes only. API routes (including the Clerk webhook, whose only
// credential is its signature) are not matched: they authenticate themselves.
export const config = {
  matcher: [
    '/dashboard/:path*',
    '/profile/edit',
    '/projects/new',
    '/teams/new',
    '/hackathons/new',
    '/messages/:path*',
    '/notifications',
    '/settings/:path*',
    '/signin',
    '/signup',
    '/error',
    '/onboarding',
  ],
}

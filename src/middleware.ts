import { clerkMiddleware } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { readOnboardingState, type OnboardingState } from '@/lib/onboarding-state'
import { clerkFrontendApi, newNonce, originOf, pageCsp, STATIC_PAGES } from '@/lib/security/csp'

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
// this says 'complete', every other protected route redirects here only while it
// says 'incomplete'. One source of truth, no duplicated "what counts as
// onboarded" logic. Asks /api/users/me, which answers with the caller's LOCAL
// profile. Anything but a definite answer is 'unknown' (see onboarding-state.ts)
// and never redirects.
async function onboardingState(request: NextRequest): Promise<OnboardingState> {
  try {
    const headers: Record<string, string> = { cookie: request.headers.get('cookie') || '' }
    const authorization = request.headers.get('authorization')
    if (authorization) headers.authorization = authorization
    const response = await fetch(`${request.nextUrl.origin}/api/users/me`, { headers })
    return readOnboardingState(response.status, await response.json().catch(() => null))
  } catch {
    return 'unknown'
  }
}

// The Content-Security-Policy for this page request (src/lib/security/csp.ts), with a fresh nonce. The policy is also put on the REQUEST, which is how Next
// learns the nonce and puts it on the scripts it renders. Read from process.env directly: the middleware runs on the Edge runtime and needs only these.
function cspFor(request: NextRequest): { nonce: string; policy: string } {
  const nonce = newNonce()
  const policy = pageCsp({
    nonce,
    staticPage: STATIC_PAGES.has(request.nextUrl.pathname),
    clerkFrontendApi: clerkFrontendApi(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY),
    storageOrigins: [originOf(process.env.STORAGE_PUBLIC_BASE_URL), originOf(process.env.STORAGE_ENDPOINT)].filter((o): o is string => o !== null),
    development: process.env.NODE_ENV === 'development',
  })
  return { nonce, policy }
}

function withCsp(response: NextResponse, policy: string): NextResponse {
  response.headers.set('Content-Security-Policy', policy)
  return response
}

export default clerkMiddleware(async (auth, request: NextRequest) => {
  const { nonce, policy } = cspFor(request)
  const forwarded = new Headers(request.headers)
  forwarded.set('x-nonce', nonce)
  forwarded.set('Content-Security-Policy', policy)
  const next = () => withCsp(NextResponse.next({ request: { headers: forwarded } }), policy)

  const { userId } = await auth()
  const signedIn = Boolean(userId)
  const { pathname } = request.nextUrl

  const isProtectedRoute = protectedRoutes.some(route => pathname.startsWith(route))
  const isAuthRoute = authRoutes.some(route => pathname.startsWith(route))

  if (isProtectedRoute && !signedIn) {
    const signInUrl = new URL('/signin', request.url)
    signInUrl.searchParams.set('callbackUrl', pathname)
    return withCsp(NextResponse.redirect(signInUrl), policy)
  }

  if (isAuthRoute && signedIn) {
    // Leave the sign-in pages only on a definite answer from the API. When it is
    // unknown, typically because the session cookie went stale while the browser
    // sat idle and the page's own check will not accept it, the page that sent the
    // visitor here would send them straight back: /dashboard to /signin to
    // /dashboard, forever. Serving the page instead lets its Clerk component load
    // clerk-js, which refreshes the cookie and moves on.
    if ((await onboardingState(request)) !== 'unknown') {
      return withCsp(NextResponse.redirect(new URL('/dashboard', request.url)), policy)
    }
    return next()
  }

  if (pathname === '/onboarding' && signedIn) {
    if ((await onboardingState(request)) === 'complete') {
      return withCsp(NextResponse.redirect(new URL('/dashboard', request.url)), policy)
    }
  }

  if (isProtectedRoute && pathname !== '/onboarding' && signedIn) {
    if ((await onboardingState(request)) === 'incomplete') {
      return withCsp(NextResponse.redirect(new URL('/onboarding', request.url)), policy)
    }
  }

  return next()
})

// Every page (each gets its Content-Security-Policy here); the redirects above apply only to the routes they name. API routes (including the Clerk
// webhook, whose only credential is its signature) are not matched: they authenticate themselves, and get their headers from next.config.js. Next's
// own static files and anything with a file extension are not matched either.
export const config = {
  matcher: ['/((?!api/|_next/static|_next/image|favicon.ico|.*\\..*).*)'],
}

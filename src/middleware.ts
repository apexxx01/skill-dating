import { auth } from '@/lib/auth'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

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
async function isOnboardingComplete(request: NextRequest, userId: string): Promise<boolean> {
  const user = await fetch(`${request.nextUrl.origin}/api/users/${userId}`, {
    headers: { cookie: request.headers.get('cookie') || '' }
  }).then(r => r.json())

  return Boolean(user?.headline && user?.skills?.length > 0)
}

export default async function middleware(request: NextRequest) {
  const session = await auth()
  const { pathname } = request.nextUrl

  const isProtectedRoute = protectedRoutes.some(route => pathname.startsWith(route))
  const isAuthRoute = authRoutes.some(route => pathname.startsWith(route))

  if (isProtectedRoute && !session?.user?.id) {
    const signInUrl = new URL('/signin', request.url)
    signInUrl.searchParams.set('callbackUrl', pathname)
    return NextResponse.redirect(signInUrl)
  }

  if (isAuthRoute && session?.user?.id) {
    return NextResponse.redirect(new URL('/dashboard', request.url))
  }

  if (pathname === '/onboarding' && session?.user?.id) {
    if (await isOnboardingComplete(request, session.user.id)) {
      return NextResponse.redirect(new URL('/dashboard', request.url))
    }
  }

  if (isProtectedRoute && pathname !== '/onboarding' && session?.user?.id) {
    if (!(await isOnboardingComplete(request, session.user.id))) {
      return NextResponse.redirect(new URL('/onboarding', request.url))
    }
  }

  return NextResponse.next()
}

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
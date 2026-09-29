import type { NextRequest, NextResponse } from 'next/server'
import { clientIp, consumeSafely, tooManyRequests } from '@/lib/rate-limiter'

const ACCOUNT_WINDOW_MS = 15 * 60_000
const ACCOUNT_MAX_ATTEMPTS = 10
const IP_WINDOW_MS = 15 * 60_000
const IP_MAX_ATTEMPTS = 40

// Password guessing has two shapes and each needs its own bucket:
//  - many passwords against ONE account (from any number of IPs) -> capped
//    per normalised email, so rotating addresses does not help the attacker;
//  - one source trying MANY accounts (credential stuffing) -> capped per
//    client IP, but only when the IP is genuinely known (trusted proxy). With
//    no trusted proxy every caller would land in one shared bucket, and an
//    attacker could then lock every legitimate user out, so the IP bucket is
//    skipped rather than shared.
export async function throttleCredentialsLogin(request: NextRequest): Promise<NextResponse | null> {
  let email: string | null = null
  try {
    const form = await request.clone().formData()
    const raw = form.get('email')
    if (typeof raw === 'string' && raw.length > 0 && raw.length <= 320) email = raw.trim().toLowerCase()
  } catch {
    // Unparseable body: NextAuth will reject it; only the IP bucket applies.
  }

  if (email) {
    const decision = await consumeSafely(
      `auth:login:acct:${email}`,
      { windowMs: ACCOUNT_WINDOW_MS, maxRequests: ACCOUNT_MAX_ATTEMPTS },
      { failClosed: true }
    )
    if (!decision.allowed) return tooManyRequests(decision)
  }

  const ip = clientIp(request)
  if (ip) {
    const decision = await consumeSafely(
      `auth:login:ip:${ip}`,
      { windowMs: IP_WINDOW_MS, maxRequests: IP_MAX_ATTEMPTS },
      { failClosed: true }
    )
    if (!decision.allowed) return tooManyRequests(decision)
  }

  return null
}

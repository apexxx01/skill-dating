import fs from 'fs'
import { randomBytes } from 'crypto'
import { loadEnvLocal } from './env'

// A thin client for the Clerk Backend API, used only by the test harness to create
// REAL users and REAL session tokens on the development instance. There is no
// bypass in application code: the server verifies these tokens exactly as it
// would a browser's. The secret key is read from the environment or .env.local
// and is never logged, echoed or written anywhere.

const API = 'https://api.clerk.com/v1'
const MARKER = 'skillDatingTestHarness'
const STALE_AFTER_MS = 30 * 60_000

let cachedKey: string | undefined

export function clerkSecretKey(): string {
  if (cachedKey) return cachedKey
  const key = process.env.CLERK_SECRET_KEY || loadEnvLocal().CLERK_SECRET_KEY
  if (!key) throw new Error('CLERK_SECRET_KEY is not set (environment or .env.local): the integration suite needs it')
  // Test users are created and deleted in bulk; never let that touch a production instance.
  if (!key.startsWith('sk_test_')) throw new Error('Refusing to run: CLERK_SECRET_KEY is not a development (sk_test_) key')
  cachedKey = key
  return key
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms))
}

// Never throws a message containing a header or the key: only method, path and
// Clerk's own error codes.
async function clerkFetch(method: string, path: string, body?: unknown): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(API + path, {
      method,
      headers: { Authorization: `Bearer ${clerkSecretKey()}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if ((res.status === 429 || res.status >= 500) && attempt < 6) {
      const retryAfter = Number(res.headers.get('retry-after'))
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * attempt)
      continue
    }
    const text = await res.text()
    let data: any = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = null
    }
    if (!res.ok) {
      const codes = Array.isArray(data?.errors) ? data.errors.map((e: any) => `${e.code}: ${e.long_message ?? e.message}`).join('; ') : ''
      throw Object.assign(new Error(`Clerk ${method} ${path} failed with ${res.status}${codes ? ` (${codes})` : ''}`), { status: res.status })
    }
    return data
  }
}

// ---- registry of users this run created, so teardown can delete them ----------

interface Registered {
  clerkId: string
  email: string
}

function registryPath(): string | null {
  return process.env.TEST_CLERK_REGISTRY || null
}

function register(entry: Registered) {
  const file = registryPath()
  if (file) fs.appendFileSync(file, JSON.stringify(entry) + '\n')
}

function readRegistry(): Registered[] {
  const file = registryPath()
  if (!file || !fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Registered)
}

function rewriteRegistry(entries: Registered[]) {
  const file = registryPath()
  if (file) fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''))
}

// ---- users, sessions, tokens ------------------------------------------------------

export interface ClerkTestUser {
  clerkId: string
  email: string
  username: string
}

export function randomPassword(): string {
  // Long and random so Clerk's breach/strength checks pass without being disabled.
  return `Tt-${randomBytes(18).toString('base64url')}-9`
}

export async function createClerkUser(email: string, username: string, extra: Record<string, unknown> = {}): Promise<ClerkTestUser> {
  const data = await clerkFetch('POST', '/users', {
    email_address: [email],
    username,
    password: randomPassword(),
    first_name: username,
    public_metadata: { [MARKER]: true },
    ...extra,
  })
  register({ clerkId: data.id, email })
  return { clerkId: data.id, email, username }
}

export async function createSession(clerkId: string): Promise<string> {
  const data = await clerkFetch('POST', '/sessions', { user_id: clerkId })
  return data.id as string
}

/** A real session token for the session; valid for about 60 seconds. */
export async function mintToken(sessionId: string): Promise<string> {
  const data = await clerkFetch('POST', `/sessions/${sessionId}/tokens`, {})
  return data.jwt as string
}

export async function getClerkUser(clerkId: string): Promise<any> {
  return clerkFetch('GET', `/users/${clerkId}`)
}

export async function deleteClerkUser(clerkId: string): Promise<void> {
  try {
    await clerkFetch('DELETE', `/users/${clerkId}`)
  } catch (error) {
    if ((error as { status?: number }).status !== 404) throw error
  }
}

/** Deletes this run's Clerk users whose email contains `marker` (used by per-file cleanup). */
export async function deleteRegisteredUsers(marker?: string): Promise<void> {
  const all = readRegistry()
  const doomed = marker ? all.filter((e) => e.email.includes(marker)) : all
  const kept = marker ? all.filter((e) => !e.email.includes(marker)) : []
  for (const entry of doomed) await deleteClerkUser(entry.clerkId)
  rewriteRegistry(kept)
}

/** Removes harness users left behind by a crashed run. Only ones this harness marked, and only old ones. */
export async function sweepStaleTestUsers(): Promise<number> {
  let removed = 0
  const cutoff = Date.now() - STALE_AFTER_MS
  for (let offset = 0; offset < 2000; offset += 100) {
    const page = await clerkFetch('GET', `/users?limit=100&offset=${offset}&order_by=-created_at`)
    if (!Array.isArray(page) || page.length === 0) break
    for (const u of page) {
      if (u?.public_metadata?.[MARKER] === true && typeof u.created_at === 'number' && u.created_at < cutoff) {
        await deleteClerkUser(u.id)
        removed += 1
      }
    }
  }
  return removed
}

export async function countClerkUsers(): Promise<number> {
  const data = await clerkFetch('GET', '/users/count')
  return data.total_count as number
}

export async function updateClerkUser(clerkId: string, body: Record<string, unknown>): Promise<any> {
  return clerkFetch('PATCH', `/users/${clerkId}`, body)
}

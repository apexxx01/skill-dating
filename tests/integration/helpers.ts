import { INTEGRATION_BASE_URL } from './config'
import { createClerkUser, createSession, mintToken } from './clerk-api'

// A client identity. Signed-in jars carry a real Clerk session and mint real
// session tokens (they last about 60 seconds) as needed; `req` sends the current
// one as a bearer token. `header()` is the same token in the `__session` cookie
// form a browser would send, for tests that build their own fetch.
export interface Jar {
  apply(headers: Headers): void
  header(): string
  ip: string
  /** A session token that is valid right now (minting a new one when the cached one is close to expiry). */
  token(): Promise<string | null>
  /** Refreshes the token that `header()` returns. */
  refresh(): Promise<void>
}

const TOKEN_LIFETIME_MS = 60_000
const REFRESH_MARGIN_MS = 25_000

// The server trusts exactly one proxy hop (TRUSTED_PROXY_HOPS=1), so a real
// deployment's proxy would append the caller's address to X-Forwarded-For.
// Each simulated client gets its own synthetic address the same way, which
// keeps the many users these tests create from sharing one rate-limit bucket.
export function syntheticIp(): string {
  const octet = (max: number) => Math.floor(Math.random() * max)
  return `10.${octet(256)}.${octet(256)}.${octet(254) + 1}`
}

export function cookieJar(ip: string = syntheticIp(), mint?: () => Promise<string>): Jar {
  const jar = new Map<string, string>()
  let current: { value: string; mintedAt: number } | null = null
  const token = async (): Promise<string | null> => {
    if (!mint) return null
    if (!current || Date.now() - current.mintedAt > TOKEN_LIFETIME_MS - REFRESH_MARGIN_MS) {
      current = { value: await mint(), mintedAt: Date.now() }
    }
    return current.value
  }
  return {
    ip,
    token,
    async refresh() {
      await token()
    },
    apply(headers: Headers) {
      const setCookies = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? []
      for (const sc of setCookies) {
        const [pair] = sc.split(';')
        const idx = pair.indexOf('=')
        jar.set(pair.slice(0, idx), pair.slice(idx + 1))
      }
    },
    header() {
      const cookies = [...jar.entries()].map(([k, v]) => `${k}=${v}`)
      if (current) cookies.push(`__session=${current.value}`)
      return cookies.join('; ')
    },
  }
}

export interface ApiResult {
  status: number
  data: any
}

export async function req(
  jar: Jar | null,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<ApiResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-forwarded-for': jar ? jar.ip : syntheticIp(),
    ...extraHeaders,
  }
  if (jar) {
    const token = await jar.token()
    if (token) headers.Authorization = `Bearer ${token}`
    const cookie = jar.header()
    if (cookie && !token) headers.Cookie = cookie
  }
  const res = await fetch(INTEGRATION_BASE_URL + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  })
  if (jar) jar.apply(res.headers)
  const text = await res.text()
  let data: any = null
  try {
    data = JSON.parse(text)
  } catch {
    data = text
  }
  return { status: res.status, data }
}

export interface TestUser {
  jar: Jar
  userId: string
}

/**
 * A real user: created on the Clerk development instance with the Backend API
 * (email, username, random password - no phone), signed in through a real
 * session, and known locally after its first authenticated request, which is the
 * lazy sync the server does for every new Clerk account. `userId` is the LOCAL
 * user id. `_password` is ignored: passwords are random and never needed.
 */
export async function registerAndLogin(email: string, username: string, _password?: string): Promise<TestUser> {
  const clerkUser = await createClerkUser(email, username)
  const sessionId = await createSession(clerkUser.clerkId)
  const jar = cookieJar(syntheticIp(), () => mintToken(sessionId))

  const me = await req(jar, 'GET', '/api/users/me')
  if (me.status !== 200 || !me.data?.id) throw new Error('sign-in failed: ' + JSON.stringify(me))

  return { jar, userId: me.data.id }
}

let counter = 0
export function uniqueSuffix(): string {
  counter += 1
  return `${Date.now()}${counter}`
}

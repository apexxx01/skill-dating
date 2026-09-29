import { INTEGRATION_BASE_URL } from './config'

export interface Jar {
  apply(headers: Headers): void
  header(): string
  ip: string
}

// The server trusts exactly one proxy hop (TRUSTED_PROXY_HOPS=1), so a real
// deployment's proxy would append the caller's address to X-Forwarded-For.
// Each simulated client gets its own synthetic address the same way, which
// keeps the many users these tests create from sharing one rate-limit bucket.
export function syntheticIp(): string {
  const octet = (max: number) => Math.floor(Math.random() * max)
  return `10.${octet(256)}.${octet(256)}.${octet(254) + 1}`
}

export function cookieJar(ip: string = syntheticIp()): Jar {
  const jar = new Map<string, string>()
  return {
    ip,
    apply(headers: Headers) {
      const setCookies = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? []
      for (const sc of setCookies) {
        const [pair] = sc.split(';')
        const idx = pair.indexOf('=')
        jar.set(pair.slice(0, idx), pair.slice(idx + 1))
      }
    },
    header() {
      return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
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
  if (jar) headers.Cookie = jar.header()
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

export async function registerAndLogin(email: string, username: string, password = 'password123'): Promise<TestUser> {
  const jar = cookieJar()
  const r = await req(jar, 'POST', '/api/auth/register', { name: username, username, email, password })
  if (r.status !== 201) throw new Error('register failed: ' + JSON.stringify(r))

  const csrfRes = await fetch(INTEGRATION_BASE_URL + '/api/auth/csrf', { headers: { 'x-forwarded-for': jar.ip } })
  jar.apply(csrfRes.headers)
  const { csrfToken } = await csrfRes.json()

  const form = new URLSearchParams({ email, password, csrfToken, json: 'true' })
  const cb = await fetch(INTEGRATION_BASE_URL + '/api/auth/callback/credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar.header(), 'x-forwarded-for': jar.ip },
    body: form.toString(),
    redirect: 'manual',
  })
  jar.apply(cb.headers)

  const sessionRes = await fetch(INTEGRATION_BASE_URL + '/api/auth/session', { headers: { Cookie: jar.header(), 'x-forwarded-for': jar.ip } })
  jar.apply(sessionRes.headers)
  const session = await sessionRes.json()
  if (!session?.user?.id) throw new Error('login failed: ' + JSON.stringify(session))

  return { jar, userId: session.user.id }
}

let counter = 0
export function uniqueSuffix(): string {
  counter += 1
  return `${Date.now()}${counter}`
}

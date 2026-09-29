import { INTEGRATION_BASE_URL } from './global-setup'

export interface Jar {
  apply(headers: Headers): void
  header(): string
}

export function cookieJar(): Jar {
  const jar = new Map<string, string>()
  return {
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

export async function req(jar: Jar | null, method: string, path: string, body?: unknown): Promise<ApiResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
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
  const r = await req(null, 'POST', '/api/auth/register', { name: username, username, email, password })
  if (r.status !== 201) throw new Error('register failed: ' + JSON.stringify(r))

  const jar = cookieJar()
  const csrfRes = await fetch(INTEGRATION_BASE_URL + '/api/auth/csrf')
  jar.apply(csrfRes.headers)
  const { csrfToken } = await csrfRes.json()

  const form = new URLSearchParams({ email, password, csrfToken, json: 'true' })
  const cb = await fetch(INTEGRATION_BASE_URL + '/api/auth/callback/credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar.header() },
    body: form.toString(),
    redirect: 'manual',
  })
  jar.apply(cb.headers)

  const sessionRes = await fetch(INTEGRATION_BASE_URL + '/api/auth/session', { headers: { Cookie: jar.header() } })
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

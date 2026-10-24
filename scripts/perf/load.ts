/**
 * npm run perf:load -- --url http://localhost:3000 --sessions sess_a,sess_b,... [--duration 20] [--connections 10] [--only feed,drops,search,leaderboard,squad] [--hackathon <id>]
 * npm run perf:load -- --url https://preview.example.com --tokens "<jwt>,<jwt>" --duration 10
 *
 * Load against a running deployment (local or a preview) with autocannon: the feed, today's drops, search, the leaderboard and the squad builder. Sign-in is a real one:
 *   --sessions   Clerk session ids; fresh session tokens (they live about a minute) are minted with CLERK_SECRET_KEY every 40 seconds, and requests rotate through the people
 *   --tokens     ready-made session tokens, for a run shorter than their life
 * The routes are rate limited per person and that is part of the product, so one person can only be asked so much: the report counts 2xx, 429 (limited) and everything else apart, and
 * the latencies are those of the answered requests. More sessions, more load. The squad builder is limited to 20 proposals an hour per person, so it is exercised in a short, last pass.
 * It never prints a token or a key. Running it against production is refused.
 */
import autocannon from 'autocannon'

interface Target {
  name: string
  method: 'GET' | 'POST'
  path: string
  body?: unknown
}

const argv = process.argv.slice(2)
const arg = (name: string, fallback?: string): string | undefined => {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (i < 0) return fallback
  return argv[i].includes('=') ? argv[i].split('=').slice(1).join('=') : (argv[i + 1] ?? fallback)
}

async function mint(sessionId: string, secret: string): Promise<string> {
  const res = await fetch(`https://api.clerk.com/v1/sessions/${sessionId}/tokens`, { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: '{}' })
  if (!res.ok) throw new Error(`could not mint a session token (${res.status})`)
  return ((await res.json()) as { jwt: string }).jwt
}

async function main() {
  const url = (arg('url') ?? '').replace(/\/+$/, '')
  if (!/^https?:\/\//.test(url)) throw new Error('--url is required, such as http://localhost:3000 or the address of a preview deployment')
  if (/(^|\.)skilldating\.(com|app|io)$/i.test(new URL(url).hostname)) throw new Error('Refusing to load-test what looks like the production site. Use a preview deployment or a local server.')
  const duration = Number(arg('duration', '20'))
  const connections = Number(arg('connections', '10'))
  const only = (arg('only') ?? 'feed,drops,search,leaderboard,squad').split(',')
  const sessions = (arg('sessions') ?? '').split(',').filter(Boolean)
  let tokens = (arg('tokens') ?? '').split(',').filter(Boolean)
  const secret = process.env.CLERK_SECRET_KEY
  if (sessions.length > 0 && !secret) throw new Error('--sessions needs CLERK_SECRET_KEY in the environment (it is used to mint session tokens and is never printed)')
  if (sessions.length === 0 && tokens.length === 0) throw new Error('give --sessions (with CLERK_SECRET_KEY) or --tokens')

  const refresh = async () => {
    if (sessions.length > 0) tokens = await Promise.all(sessions.map((id) => mint(id, secret!)))
  }
  await refresh()
  const timer = sessions.length > 0 ? setInterval(() => void refresh().catch(() => undefined), 40_000) : undefined

  const targets: Target[] = [
    { name: 'feed', method: 'GET', path: '/api/feed?tab=for-you&limit=20' },
    { name: 'drops', method: 'GET', path: '/api/drops/today' },
    { name: 'search', method: 'GET', path: '/api/search?q=react' },
    { name: 'leaderboard', method: 'GET', path: '/api/leaderboard?scope=global&period=weekly' },
  ]
  const hackathon = arg('hackathon')
  if (hackathon) targets.push({ name: 'squad', method: 'POST', path: `/api/hackathons/${hackathon}/squad-builder`, body: { size: 4 } })

  console.log(`Load against ${new URL(url).host}: ${connections} connections for ${duration} s per route, ${tokens.length} signed-in ${tokens.length === 1 ? 'person' : 'people'}\n`)
  console.log('route'.padEnd(13) + 'req/s'.padStart(8) + '2xx'.padStart(8) + '429'.padStart(8) + 'other'.padStart(8) + 'p50 ms'.padStart(9) + 'p97.5'.padStart(9) + 'p99'.padStart(9))
  let turn = 0
  for (const target of targets.filter((t) => only.includes(t.name))) {
    const short = target.name === 'squad'
    const result = await autocannon({
      url: url + target.path,
      method: target.method,
      connections: short ? Math.min(connections, 3) : connections,
      duration: short ? 5 : duration,
      body: target.body ? JSON.stringify(target.body) : undefined,
      headers: target.body ? { 'content-type': 'application/json' } : {},
      requests: [
        {
          setupRequest: (req: { headers?: Record<string, string> }) => {
            turn += 1
            req.headers = { ...(req.headers ?? {}), authorization: `Bearer ${tokens[turn % tokens.length]}` }
            return req
          },
        },
      ] as never,
    })
    const rate = (result as unknown as { statusCodeStats: Record<string, { count: number }> }).statusCodeStats ?? {}
    const count = (test: (code: number) => boolean) => Object.entries(rate).filter(([code]) => test(Number(code))).reduce((sum, [, v]) => sum + v.count, 0)
    console.log(
      target.name.padEnd(13) +
        String(Math.round(result.requests.average)).padStart(8) +
        String(count((c) => c >= 200 && c < 300)).padStart(8) +
        String(count((c) => c === 429)).padStart(8) +
        String(count((c) => c !== 429 && (c < 200 || c >= 300))).padStart(8) +
        String(result.latency.p50).padStart(9) +
        String(result.latency.p97_5).padStart(9) +
        String(result.latency.p99).padStart(9)
    )
  }
  if (timer) clearInterval(timer)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})

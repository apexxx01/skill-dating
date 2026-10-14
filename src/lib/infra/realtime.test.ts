import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetEnvCache } from '@/lib/env'
import {
  AblyRealtime,
  MAX_CHANNELS_PER_TOKEN,
  authorizeChannels,
  capabilityFor,
  conversationChannel,
  createAblyRealtime,
  createRealtime,
  parseChannel,
  teamChannel,
  userChannel,
  type AblyRestLike,
} from './realtime'
import { MemoryRealtime } from './realtime.memory'

describe('channel names', () => {
  it('parses the three kinds', () => {
    expect(parseChannel('user:abc123')).toEqual({ kind: 'user', id: 'abc123' })
    expect(parseChannel('conversation:c_1-x')).toEqual({ kind: 'conversation', id: 'c_1-x' })
    expect(parseChannel('team:t1')).toEqual({ kind: 'team', id: 't1' })
  })

  it('rejects anything else, including wildcards and separators that widen a capability', () => {
    for (const bad of ['', 'user:', 'user:*', '*', 'admin:1', 'user:a:b', 'user:a b', 'user:a*', 'team:a/b', 'USER:a', `user:${'x'.repeat(65)}`, 'conversation:[?rewind=1]x']) {
      expect(parseChannel(bad), bad).toBeNull()
    }
  })

  it('builds names the parser accepts', () => {
    expect(parseChannel(userChannel('u1'))).toEqual({ kind: 'user', id: 'u1' })
    expect(parseChannel(conversationChannel('c1'))).toEqual({ kind: 'conversation', id: 'c1' })
    expect(parseChannel(teamChannel('t1'))).toEqual({ kind: 'team', id: 't1' })
  })
})

describe('authorizeChannels', () => {
  const prisma = (members: { conversation?: string[]; team?: string[] } = {}) =>
    ({
      conversationMember: {
        findUnique: vi.fn(async ({ where }: any) =>
          members.conversation?.includes(where.userId_conversationId.conversationId) ? { id: 'm' } : null
        ),
      },
      teamMember: {
        findUnique: vi.fn(async ({ where }: any) => (members.team?.includes(where.userId_teamId.teamId) ? { id: 'm' } : null)),
      },
    }) as any

  it('lets a user have their own channel and nobody else’s', async () => {
    expect(await authorizeChannels(prisma(), 'u1', ['user:u1', 'user:u2'])).toEqual({ allowed: ['user:u1'], denied: ['user:u2'] })
  })

  it('grants conversation and team channels to members only', async () => {
    const db = prisma({ conversation: ['c1'], team: ['t1'] })
    const result = await authorizeChannels(db, 'u1', ['conversation:c1', 'conversation:c2', 'team:t1', 'team:t2'])
    expect(result.allowed).toEqual(['conversation:c1', 'team:t1'])
    expect(result.denied).toEqual(['conversation:c2', 'team:t2'])
    expect(db.conversationMember.findUnique).toHaveBeenCalledWith({ where: { userId_conversationId: { userId: 'u1', conversationId: 'c1' } } })
  })

  it('denies names that are not channels without asking the database', async () => {
    const db = prisma()
    const result = await authorizeChannels(db, 'u1', ['*', 'user:*', 'other:1'])
    expect(result.allowed).toEqual([])
    expect(result.denied).toEqual(['*', 'user:*', 'other:1'])
    expect(db.conversationMember.findUnique).not.toHaveBeenCalled()
  })

  it('counts a repeated channel once', async () => {
    expect(await authorizeChannels(prisma(), 'u1', ['user:u1', 'user:u1'])).toEqual({ allowed: ['user:u1'], denied: [] })
  })

  it('exposes a sane ceiling on channels per token', () => {
    expect(MAX_CHANNELS_PER_TOKEN).toBeGreaterThan(0)
  })
})

describe('capabilityFor', () => {
  it('grants subscribe and nothing else on each channel', () => {
    expect(capabilityFor(['user:u1', 'team:t1'])).toEqual({ 'user:u1': ['subscribe'], 'team:t1': ['subscribe'] })
  })
})

describe('AblyRealtime (against the real SDK, offline)', () => {
  // Token requests are signed locally with the key, so no network is involved.
  const realtime = createAblyRealtime('testApp.testKey:testSecret')

  it('signs a subscribe-only request bound to the user', async () => {
    const request = await realtime.issueToken('user-1', ['user:user-1', 'conversation:c1'], 60_000)
    expect(request.keyName).toBe('testApp.testKey')
    expect(request.clientId).toBe('user-1')
    expect(JSON.parse(request.capability)).toEqual({ 'user:user-1': ['subscribe'], 'conversation:c1': ['subscribe'] })
    expect(request.ttl).toBe(60_000)
    expect(request.mac.length).toBeGreaterThan(10)
  })

  it('never includes the secret in what it hands out', async () => {
    const request = await realtime.issueToken('user-1', ['user:user-1'])
    expect(JSON.stringify(request)).not.toContain('testSecret')
  })

  it('signs differently each time', async () => {
    const a = await realtime.issueToken('user-1', ['user:user-1'])
    const b = await realtime.issueToken('user-1', ['user:user-1'])
    expect(a.nonce).not.toBe(b.nonce)
    expect(a.mac).not.toBe(b.mac)
  })
})

describe('AblyRealtime', () => {
  it('publishes to the named channel', async () => {
    const publish = vi.fn().mockResolvedValue(undefined)
    const get = vi.fn().mockReturnValue({ publish })
    const rest: AblyRestLike = { channels: { get }, auth: { createTokenRequest: vi.fn() } }
    await new AblyRealtime(rest).publish('conversation:c1', 'message.created', { id: 'm1' })
    expect(get).toHaveBeenCalledWith('conversation:c1')
    expect(publish).toHaveBeenCalledWith('message.created', { id: 'm1' })
  })

  it('lets a publish failure reach the caller', async () => {
    const rest: AblyRestLike = {
      channels: { get: () => ({ publish: async () => { throw new Error('ably down') } }) },
      auth: { createTokenRequest: vi.fn() },
    }
    await expect(new AblyRealtime(rest).publish('user:u1', 'x', {})).rejects.toThrow('ably down')
  })
})

describe('MemoryRealtime', () => {
  it('delivers to subscribers of that channel only, and records everything', async () => {
    const realtime = new MemoryRealtime()
    const seen: unknown[] = []
    const stop = realtime.subscribe('user:u1', (m) => seen.push(m.data))
    await realtime.publish('user:u1', 'notification', { n: 1 })
    await realtime.publish('user:u2', 'notification', { n: 2 })
    stop()
    await realtime.publish('user:u1', 'notification', { n: 3 })
    expect(seen).toEqual([{ n: 1 }])
    expect(realtime.published).toHaveLength(3)
  })

  it('issues a token request with the same capability shape as the real one', async () => {
    const request = await new MemoryRealtime().issueToken('u1', ['user:u1'])
    expect(request.clientId).toBe('u1')
    expect(JSON.parse(request.capability)).toEqual({ 'user:u1': ['subscribe'] })
  })
})

describe('createRealtime', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
    resetEnvCache()
  })

  it('uses the in-process implementation without an Ably key', () => {
    delete process.env.ABLY_API_KEY
    resetEnvCache()
    expect(createRealtime().kind).toBe('memory')
  })

  it('uses Ably when a key is set', () => {
    process.env.ABLY_API_KEY = 'app.key:secret'
    resetEnvCache()
    expect(createRealtime().kind).toBe('ably')
  })
})

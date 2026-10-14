import Ably from 'ably'
import { env } from '@/lib/env'
import { checkMembership } from '@/lib/api/permissions'
import type { prisma as PrismaClient } from '@/lib/prisma'
import { MemoryRealtime } from './realtime.memory'

// Server-pushed events (new message, notification, team change). The server
// publishes; browsers only subscribe, using short-lived tokens from
// POST /api/realtime/token that name exactly the channels the user may read.
// Callers depend on `Realtime`; Ably is the production implementation and
// `MemoryRealtime` (realtime.memory.ts) the in-process one for tests and
// development. Swapping provider means writing another `Realtime`.
//
// The provider's API key never leaves the server. A token carries the user's
// id as its client id and `subscribe` on listed channels only, so a client
// cannot publish, and cannot subscribe anywhere it was not granted.

/** A signed request a browser exchanges with the provider for a token. */
export interface RealtimeTokenRequest {
  keyName: string
  clientId?: string
  capability: string
  timestamp: number
  nonce: string
  mac: string
  ttl?: number
}

export interface Realtime {
  readonly kind: 'memory' | 'ably'
  publish(channel: string, event: string, data: unknown): Promise<void>
  /** A subscribe-only token request for `clientId`, valid for `channels` and `ttlMs`. */
  issueToken(clientId: string, channels: string[], ttlMs?: number): Promise<RealtimeTokenRequest>
}

export const TOKEN_TTL_MS = 15 * 60_000
export const MAX_CHANNELS_PER_TOKEN = 20

// --- Channels ----------------------------------------------------------------
// user:<userId>          private to that user (their notifications)
// conversation:<id>      members of the conversation
// team:<id>              members of the team

export type ChannelKind = 'user' | 'conversation' | 'team'

const CHANNEL_PATTERN = /^(user|conversation|team):([A-Za-z0-9_-]{1,64})$/

export function parseChannel(name: string): { kind: ChannelKind; id: string } | null {
  const match = CHANNEL_PATTERN.exec(name)
  return match ? { kind: match[1] as ChannelKind, id: match[2] } : null
}

export const userChannel = (userId: string) => `user:${userId}`
export const conversationChannel = (conversationId: string) => `conversation:${conversationId}`
export const teamChannel = (teamId: string) => `team:${teamId}`

export interface ChannelDecision {
  allowed: string[]
  denied: string[]
}

/** Splits requested channels into the ones this user may subscribe to and the rest. */
export async function authorizeChannels(
  prisma: typeof PrismaClient,
  userId: string,
  requested: string[]
): Promise<ChannelDecision> {
  const allowed: string[] = []
  const denied: string[] = []
  for (const name of new Set(requested)) {
    const channel = parseChannel(name)
    let ok = false
    if (channel?.kind === 'user') ok = channel.id === userId
    else if (channel) ok = await checkMembership(prisma, userId, channel.kind, channel.id)
    ;(ok ? allowed : denied).push(name)
  }
  return { allowed, denied }
}

/** Subscribe-only capability for exactly these channels. */
export function capabilityFor(channels: string[]): Record<string, string[]> {
  return Object.fromEntries(channels.map((channel) => [channel, ['subscribe']]))
}

// --- Ably --------------------------------------------------------------------

/** The slice of the Ably REST client in use, so it can be tested without a network. */
export interface AblyRestLike {
  channels: { get(name: string): { publish(event: string, data: unknown): Promise<unknown> } }
  auth: {
    createTokenRequest(params: {
      clientId: string
      capability: Record<string, string[]>
      ttl: number
    }): Promise<RealtimeTokenRequest>
  }
}

export class AblyRealtime implements Realtime {
  readonly kind = 'ably' as const

  constructor(private readonly rest: AblyRestLike) {}

  async publish(channel: string, event: string, data: unknown) {
    await this.rest.channels.get(channel).publish(event, data)
  }

  // Signing happens locally with the API key; no request is made to Ably.
  issueToken(clientId: string, channels: string[], ttlMs: number = TOKEN_TTL_MS) {
    return this.rest.auth.createTokenRequest({ clientId, capability: capabilityFor(channels), ttl: ttlMs })
  }
}

export function createAblyRealtime(apiKey: string): Realtime {
  return new AblyRealtime(new Ably.Rest({ key: apiKey }) as unknown as AblyRestLike)
}

/** Ably when it is configured, otherwise the in-process stand-in. */
export function createRealtime(): Realtime {
  return env.ABLY_API_KEY ? createAblyRealtime(env.ABLY_API_KEY) : new MemoryRealtime()
}

const globalForRealtime = globalThis as unknown as { __realtime?: Realtime }

export function getRealtime(): Realtime {
  if (!globalForRealtime.__realtime) globalForRealtime.__realtime = createRealtime()
  return globalForRealtime.__realtime
}

/** Replaces the process-wide realtime (tests). */
export function setRealtime(realtime: Realtime | undefined) {
  globalForRealtime.__realtime = realtime
}

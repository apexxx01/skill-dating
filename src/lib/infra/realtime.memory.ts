import type { Realtime, RealtimeTokenRequest } from './realtime'

// In-process `Realtime`. Publishing delivers to subscribers in this process and
// records the message; tokens are shaped like the real ones but carry no
// signature, so they are only good for tests and local development.

export interface PublishedMessage {
  channel: string
  event: string
  data: unknown
}

type Listener = (message: PublishedMessage) => void

const DEFAULT_TTL_MS = 15 * 60_000

export class MemoryRealtime implements Realtime {
  readonly kind = 'memory' as const
  readonly published: PublishedMessage[] = []
  private readonly listeners = new Map<string, Set<Listener>>()

  async publish(channel: string, event: string, data: unknown) {
    const message = { channel, event, data }
    this.published.push(message)
    for (const listener of this.listeners.get(channel) ?? []) listener(message)
  }

  subscribe(channel: string, listener: Listener): () => void {
    const set = this.listeners.get(channel) ?? new Set<Listener>()
    set.add(listener)
    this.listeners.set(channel, set)
    return () => set.delete(listener)
  }

  async issueToken(clientId: string, channels: string[], ttlMs: number = DEFAULT_TTL_MS): Promise<RealtimeTokenRequest> {
    return {
      keyName: 'memory.key',
      clientId,
      capability: JSON.stringify(Object.fromEntries(channels.map((channel) => [channel, ['subscribe']]))),
      timestamp: Date.now(),
      nonce: Math.random().toString(36).slice(2),
      mac: 'unsigned-memory-token',
      ttl: ttlMs,
    }
  }
}

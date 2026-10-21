import type { ObjectInfo, PresignedUpload, Storage } from './storage'

// The same defaults as storage.ts, repeated so this file needs only its types (storage.ts imports this one).
const UPLOAD_URL_TTL_SECONDS = 10 * 60
const READ_URL_TTL_SECONDS = 15 * 60

// In-process `Storage`. It hands out URLs that look like the real ones (memory://...), keeps what a test "uploads" with simulateUpload(), and answers
// head() from that. Nothing is shared between processes and nothing survives a restart, so it is only for tests and local development.

export class MemoryStorage implements Storage {
  readonly kind = 'memory' as const
  readonly objects = new Map<string, ObjectInfo>()
  /** The bytes of objects written with put() (uploads by people keep only their size and type). */
  readonly contents = new Map<string, Uint8Array>()

  constructor(private readonly clock: () => Date = () => new Date()) {}

  async presignUpload({ key, contentType, ttlSeconds = UPLOAD_URL_TTL_SECONDS, origin }: { key: string; contentType: string; ttlSeconds?: number; origin?: string }): Promise<PresignedUpload> {
    return {
      method: 'PUT',
      // With an origin the "bucket" is a route of this server (PUT /api/media/dev-upload/<key>, which exists only while this stand-in is in use), so uploads work end to end in development.
      url: origin ? `${origin.replace(/\/+$/, '')}/api/media/dev-upload/${key}` : `memory://upload/${key}`,
      headers: { 'Content-Type': contentType },
      expiresAt: new Date(this.clock().getTime() + ttlSeconds * 1000),
    }
  }

  /** What a client's PUT to the presigned URL would have stored. */
  simulateUpload(key: string, object: ObjectInfo) {
    this.objects.set(key, object)
  }

  async head(key: string): Promise<ObjectInfo | null> {
    return this.objects.get(key) ?? null
  }

  async signedReadUrl(key: string, ttlSeconds = READ_URL_TTL_SECONDS, origin?: string): Promise<string> {
    const expires = Math.floor(this.clock().getTime() / 1000) + ttlSeconds
    // With an origin the object is read through this server (GET /api/media/dev-download/<key>, only while this stand-in is in use).
    return origin ? `${origin.replace(/\/+$/, '')}/api/media/dev-download/${key}?expires=${expires}` : `memory://read/${key}?expires=${expires}`
  }

  async put(key: string, body: string | Uint8Array, contentType: string): Promise<void> {
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
    this.contents.set(key, bytes)
    this.objects.set(key, { size: bytes.byteLength, contentType })
  }

  publicUrl(key: string): string | null {
    return `memory://public/${key}`
  }

  async remove(key: string): Promise<void> {
    this.objects.delete(key)
    this.contents.delete(key)
  }
}

import { env } from '@/lib/env'
import { encodeKeyPath, presignUrl } from './sigv4'
import { MemoryStorage } from './storage.memory'

// Object storage for uploads (post media and romance photos). Callers depend on `Storage`; an S3-compatible store (AWS S3, Cloudflare R2, MinIO) is the
// production implementation and `MemoryStorage` (storage.memory.ts) the in-process one for tests and development. Without the STORAGE_* settings a
// production process gets `UnavailableStorage`, which REFUSES every call: uploads are an optional capability, and a deployment that has not configured a
// bucket must say so (503 STORAGE_UNAVAILABLE) rather than pretend to store files in memory it will lose.
//
// Uploads never pass through this server. The contract is a presigned URL: the server checks a declaration (src/lib/media.ts), signs a PUT for exactly
// that key and content type, the client uploads straight to the bucket, and the server then HEADs the object to check its real size and type before it is
// used (src/lib/media-assets.ts). Reads of private objects (romance photos) are signed, short-lived GET URLs, made only after the access rule is satisfied.

export interface PresignedUpload {
  method: 'PUT'
  url: string
  /** Headers the client must send exactly as given (they are part of the signature). */
  headers: Record<string, string>
  expiresAt: Date
}

export interface ObjectInfo {
  size: number
  contentType: string | null
}

export interface Storage {
  readonly kind: 'memory' | 's3' | 'unavailable'
  /** `origin` (this server's, e.g. http://localhost:3000) is used only by the in-memory stand-in, whose "bucket" is a route of this server. */
  presignUpload(input: { key: string; contentType: string; ttlSeconds?: number; origin?: string }): Promise<PresignedUpload>
  /** The stored object's real size and type, or null when nothing is there. */
  head(key: string): Promise<ObjectInfo | null>
  /** A short-lived URL to read a private object. */
  signedReadUrl(key: string, ttlSeconds?: number): Promise<string>
  /** The permanent public URL of an object, when the bucket is served publicly (STORAGE_PUBLIC_BASE_URL); null otherwise. */
  publicUrl(key: string): string | null
  remove(key: string): Promise<void>
}

export class StorageUnavailableError extends Error {
  constructor() {
    super('Object storage is not configured')
    this.name = 'StorageUnavailableError'
  }
}

export const UPLOAD_URL_TTL_SECONDS = 10 * 60
export const READ_URL_TTL_SECONDS = 15 * 60

export interface S3Config {
  endpoint: string
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  publicBaseUrl?: string
}

type FetchLike = (input: string, init?: { method?: string }) => Promise<Pick<Response, 'ok' | 'status' | 'headers'>>

export class S3Storage implements Storage {
  readonly kind = 's3' as const
  private readonly host: string
  private readonly basePath: string

  constructor(
    private readonly config: S3Config,
    private readonly fetcher: FetchLike = fetch as unknown as FetchLike,
    private readonly clock: () => Date = () => new Date()
  ) {
    const url = new URL(config.endpoint)
    this.host = url.host
    // Path-style addressing: /<bucket>/<key>, which every S3-compatible store accepts.
    this.basePath = `${url.pathname.replace(/\/+$/, '')}/${encodeURIComponent(config.bucket)}`
  }

  private url(method: 'GET' | 'PUT' | 'HEAD' | 'DELETE', key: string, ttlSeconds: number, headers?: Record<string, string>): string {
    return presignUrl({
      method,
      host: this.host,
      path: `${this.basePath}/${encodeKeyPath(key)}`,
      region: this.config.region,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      expiresSeconds: ttlSeconds,
      now: this.clock(),
      headers,
    })
  }

  async presignUpload({ key, contentType, ttlSeconds = UPLOAD_URL_TTL_SECONDS }: { key: string; contentType: string; ttlSeconds?: number; origin?: string }): Promise<PresignedUpload> {
    const headers = { 'content-type': contentType }
    return { method: 'PUT', url: this.url('PUT', key, ttlSeconds, headers), headers: { 'Content-Type': contentType }, expiresAt: new Date(this.clock().getTime() + ttlSeconds * 1000) }
  }

  async head(key: string): Promise<ObjectInfo | null> {
    const response = await this.fetcher(this.url('HEAD', key, 60), { method: 'HEAD' })
    if (response.status === 404 || response.status === 403) return null
    if (!response.ok) throw new Error(`storage HEAD failed with ${response.status}`)
    const length = Number(response.headers.get('content-length'))
    return { size: Number.isFinite(length) ? length : 0, contentType: response.headers.get('content-type') }
  }

  async signedReadUrl(key: string, ttlSeconds = READ_URL_TTL_SECONDS): Promise<string> {
    return this.url('GET', key, ttlSeconds)
  }

  publicUrl(key: string): string | null {
    return this.config.publicBaseUrl ? `${this.config.publicBaseUrl.replace(/\/+$/, '')}/${encodeKeyPath(key)}` : null
  }

  async remove(key: string): Promise<void> {
    const response = await this.fetcher(this.url('DELETE', key, 60), { method: 'DELETE' })
    if (!response.ok && response.status !== 404) throw new Error(`storage DELETE failed with ${response.status}`)
  }
}

export class UnavailableStorage implements Storage {
  readonly kind = 'unavailable' as const
  async presignUpload(): Promise<PresignedUpload> {
    throw new StorageUnavailableError()
  }
  async head(): Promise<ObjectInfo | null> {
    throw new StorageUnavailableError()
  }
  async signedReadUrl(): Promise<string> {
    throw new StorageUnavailableError()
  }
  publicUrl(): string | null {
    return null
  }
  async remove(): Promise<void> {
    throw new StorageUnavailableError()
  }
}

// --- Selection ---------------------------------------------------------------

export function createStorage(): Storage {
  if (env.STORAGE_ENDPOINT && env.STORAGE_BUCKET && env.STORAGE_ACCESS_KEY_ID && env.STORAGE_SECRET_ACCESS_KEY) {
    return new S3Storage({
      endpoint: env.STORAGE_ENDPOINT,
      bucket: env.STORAGE_BUCKET,
      region: env.STORAGE_REGION,
      accessKeyId: env.STORAGE_ACCESS_KEY_ID,
      secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY,
      publicBaseUrl: env.STORAGE_PUBLIC_BASE_URL,
    })
  }
  // Development and tests keep objects in this process (including the integration suite's production build); production without a bucket refuses.
  return env.NODE_ENV === 'production' && !env.INTEGRATION_TEST_SERVER ? new UnavailableStorage() : new MemoryStorage()
}

const globalForStorage = globalThis as unknown as { __storage?: Storage }

export function getStorage(): Storage {
  if (!globalForStorage.__storage) globalForStorage.__storage = createStorage()
  return globalForStorage.__storage
}

/** Replaces the process-wide storage (tests). */
export function setStorage(storage: Storage | undefined) {
  globalForStorage.__storage = storage
}

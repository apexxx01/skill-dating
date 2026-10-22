import webpush from 'web-push'
import { env } from '@/lib/env'
import type { PushOptions, PushOutcome, PushPayload, PushSender, PushTarget } from './push.contract'
import { MemoryPush } from './push.memory'

export type { PushOptions, PushOutcome, PushPayload, PushSender, PushTarget }

// Web push, with VAPID. Callers depend on `PushSender`; `WebPushSender` is the production implementation (the `web-push` library does the payload
// encryption and the VAPID signature) and `MemoryPush` (push.memory.ts) the in-process one for development and tests.
//
// The server POSTs to the endpoint a browser handed over, so an endpoint is a URL the server will call on somebody else's say-so. isPushEndpoint() keeps
// that to https URLs of the real push services (and, for the in-memory stand-in, which never calls anything, to any public https host).

export interface VapidConfig {
  publicKey: string
  privateKey: string
  subject: string
}

type SendNotification = (
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
  options: { TTL?: number; urgency?: PushOptions['urgency']; vapidDetails: { subject: string; publicKey: string; privateKey: string }; timeout?: number }
) => Promise<unknown>

export class WebPushSender implements PushSender {
  readonly kind = 'webpush' as const

  constructor(
    private readonly vapid: VapidConfig,
    private readonly sendNotification: SendNotification = webpush.sendNotification as unknown as SendNotification
  ) {}

  get publicKey() {
    return this.vapid.publicKey
  }

  async send(target: PushTarget, payload: PushPayload, options: PushOptions = {}): Promise<PushOutcome> {
    try {
      await this.sendNotification({ endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } }, JSON.stringify(payload), {
        TTL: options.ttlSeconds ?? 6 * 60 * 60,
        urgency: options.urgency ?? 'normal',
        vapidDetails: { subject: this.vapid.subject, publicKey: this.vapid.publicKey, privateKey: this.vapid.privateKey },
        timeout: 10_000,
      })
      return { ok: true }
    } catch (error) {
      const status = (error as { statusCode?: unknown }).statusCode
      if (typeof status === 'number') {
        if (status === 404 || status === 410) return { ok: false, gone: true, retryable: false, status }
        return { ok: false, gone: false, retryable: status === 429 || status >= 500, status }
      }
      // No status: the service was not reached (or the subscription's keys are malformed, which a retry will not fix but costs one more try at most).
      return { ok: false, gone: false, retryable: true, status: null }
    }
  }
}

// --- Endpoints -------------------------------------------------------------

// The push services of the browsers: Chrome and Edge's FCM, Firefox's autopush, Safari/APNs web push, Windows' WNS.
const PUSH_HOST_SUFFIXES = ['.googleapis.com', '.push.services.mozilla.com', '.push.apple.com', '.notify.windows.com'] as const

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

/** Whether the server may be asked to call this endpoint. `strict` (a real sender) restricts it to the browsers' push services. */
export function isPushEndpoint(endpoint: string, strict: boolean): boolean {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false
  const host = url.hostname.toLowerCase()
  if (strict) return PUSH_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
  return host.includes('.') && !IPV4.test(host) && !host.startsWith('[') && host !== 'localhost' && !host.endsWith('.local') && !host.endsWith('.internal')
}

// --- Selection -------------------------------------------------------------

export function createPush(): PushSender {
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT) {
    return new WebPushSender({ publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT })
  }
  return new MemoryPush()
}

const globalForPush = globalThis as unknown as { __push?: PushSender }

export function getPush(): PushSender {
  if (!globalForPush.__push) globalForPush.__push = createPush()
  return globalForPush.__push
}

/** Replaces the process-wide sender (tests). */
export function setPush(sender: PushSender | undefined) {
  globalForPush.__push = sender
}

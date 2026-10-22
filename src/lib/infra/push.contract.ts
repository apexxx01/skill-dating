// The shape of a web push sender, apart from its implementations so they can import it without importing each other.

/** A browser's push subscription, as PushManager.subscribe() gives it (the keys in base64url). */
export interface PushTarget {
  endpoint: string
  p256dh: string
  auth: string
}

export interface PushPayload {
  title: string
  body: string
  /** Where a click goes: a path in the app ("/notifications") or an absolute URL. */
  url: string
  /** Notifications with the same tag replace each other on the device. */
  tag?: string
  /** The delivery this push is, so a tap can be reported back (POST /api/notifications/deliveries/{id}/open) for the open rate. */
  deliveryId?: string
}

export interface PushOptions {
  /** How long the push service keeps the message for a device that is off, in seconds. */
  ttlSeconds?: number
  urgency?: 'very-low' | 'low' | 'normal' | 'high'
}

export type PushOutcome =
  | { ok: true }
  // `gone`: the push service says this subscription no longer exists (404 or 410): delete it. `retryable`: the service is limiting or failing: try later.
  | { ok: false; gone: boolean; retryable: boolean; status: number | null }

export interface PushSender {
  readonly kind: 'memory' | 'webpush'
  /** The VAPID public key a browser needs to subscribe (applicationServerKey), in base64url. */
  readonly publicKey: string
  send(target: PushTarget, payload: PushPayload, options?: PushOptions): Promise<PushOutcome>
}

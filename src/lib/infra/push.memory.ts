import webpush from 'web-push'
import type { PushOptions, PushOutcome, PushPayload, PushSender, PushTarget } from './push.contract'

// In-process `PushSender`. Keeps every push in `sent` instead of sending it. Its VAPID key pair is made when the process starts, so a browser in development
// can still subscribe (the keys are worth nothing, nothing is ever delivered). A test can mark an endpoint as gone, or failing, to exercise the outcomes of a
// real push service.

export interface SentPush {
  target: PushTarget
  payload: PushPayload
  options: PushOptions
  at: Date
}

export class MemoryPush implements PushSender {
  readonly kind = 'memory' as const
  readonly publicKey: string
  readonly sent: SentPush[] = []
  private readonly gone = new Set<string>()
  private readonly failing = new Map<string, { status: number; retryable: boolean }>()

  constructor() {
    this.publicKey = webpush.generateVAPIDKeys().publicKey
  }

  markGone(endpoint: string) {
    this.gone.add(endpoint)
  }

  failFor(endpoint: string, status = 503, retryable = true) {
    this.failing.set(endpoint, { status, retryable })
  }

  async send(target: PushTarget, payload: PushPayload, options: PushOptions = {}): Promise<PushOutcome> {
    if (this.gone.has(target.endpoint)) return { ok: false, gone: true, retryable: false, status: 410 }
    const failure = this.failing.get(target.endpoint)
    if (failure) return { ok: false, gone: false, retryable: failure.retryable, status: failure.status }
    this.sent.push({ target, payload, options, at: new Date() })
    return { ok: true }
  }

  to(endpoint: string): SentPush[] {
    return this.sent.filter((push) => push.target.endpoint === endpoint)
  }
}

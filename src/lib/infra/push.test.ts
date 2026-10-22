import { describe, it, expect, vi } from 'vitest'
import { WebPushSender, isPushEndpoint } from './push'
import { MemoryPush } from './push.memory'

const target = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: 'BKey', auth: 'authsecret' }
const payload = { title: 'Hello', body: 'World', url: '/notifications' }
const vapid = { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:ops@example.com' }

describe('WebPushSender', () => {
  it('sends the payload as JSON with the VAPID identity, a TTL and an urgency', async () => {
    const sendNotification = vi.fn(async () => ({}))
    const outcome = await new WebPushSender(vapid, sendNotification).send(target, payload, { ttlSeconds: 60, urgency: 'high' })
    expect(outcome).toEqual({ ok: true })
    const [subscription, body, options] = sendNotification.mock.calls[0] as unknown as [unknown, string, Record<string, unknown>]
    expect(subscription).toEqual({ endpoint: target.endpoint, keys: { p256dh: 'BKey', auth: 'authsecret' } })
    expect(JSON.parse(body)).toEqual(payload)
    expect(options).toMatchObject({ TTL: 60, urgency: 'high', vapidDetails: vapid })
  })

  it('reports a subscription the service has dropped (404, 410) as gone, so it can be deleted', async () => {
    for (const statusCode of [404, 410]) {
      const sender = new WebPushSender(vapid, async () => Promise.reject(Object.assign(new Error('gone'), { statusCode })))
      expect(await sender.send(target, payload)).toEqual({ ok: false, gone: true, retryable: false, status: statusCode })
    }
  })

  it('retries a rate limit, a server error and a service that did not answer, but not a refusal', async () => {
    const outcome = (statusCode?: number) => new WebPushSender(vapid, async () => Promise.reject(Object.assign(new Error('x'), statusCode ? { statusCode } : {}))).send(target, payload)
    expect(await outcome(429)).toMatchObject({ ok: false, gone: false, retryable: true })
    expect(await outcome(503)).toMatchObject({ retryable: true })
    expect(await outcome(400)).toMatchObject({ retryable: false, gone: false })
    expect(await outcome(undefined)).toMatchObject({ retryable: true, status: null })
  })
})

describe('isPushEndpoint', () => {
  it('accepts the browsers’ push services when strict', () => {
    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://web.push.apple.com/abc',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
    ]) {
      expect(isPushEndpoint(endpoint, true)).toBe(true)
    }
  })

  it('refuses everything else when strict, so the server cannot be pointed at an arbitrary URL', () => {
    for (const endpoint of ['https://evil.example.com/x', 'http://fcm.googleapis.com/x', 'https://fcm.googleapis.com.evil.com/x', 'https://user:pass@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'not a url', 'https://169.254.169.254/latest']) {
      expect(isPushEndpoint(endpoint, true)).toBe(false)
    }
  })

  it('lets the stand-in take any public https host, but never an address that points inside', () => {
    expect(isPushEndpoint('https://push.example.test/abc', false)).toBe(true)
    for (const endpoint of ['http://push.example.test/abc', 'https://localhost/abc', 'https://127.0.0.1/abc', 'https://10.0.0.5/abc', 'https://[::1]/abc', 'https://db.internal/abc', 'https://printer.local/abc']) {
      expect(isPushEndpoint(endpoint, false)).toBe(false)
    }
  })
})

describe('MemoryPush', () => {
  it('keeps what was sent, and reports a gone or failing endpoint like a push service', async () => {
    const push = new MemoryPush()
    expect(push.publicKey.length).toBeGreaterThan(40)
    expect(await push.send(target, payload)).toEqual({ ok: true })
    expect(push.to(target.endpoint)).toHaveLength(1)
    push.markGone(target.endpoint)
    expect(await push.send(target, payload)).toMatchObject({ ok: false, gone: true })
    const other = { ...target, endpoint: 'https://push.example.test/b' }
    push.failFor(other.endpoint)
    expect(await push.send(other, payload)).toMatchObject({ ok: false, retryable: true, status: 503 })
    expect(push.sent).toHaveLength(1)
  })
})

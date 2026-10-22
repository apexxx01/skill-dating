import { describe, it, expect, vi } from 'vitest'
import { ResendEmail, EmailSendError, type EmailMessage } from './email'
import { MemoryEmail } from './email.memory'

const message: EmailMessage = {
  to: 'ada@example.com',
  subject: 'Hello',
  html: '<p>Hello</p>',
  text: 'Hello',
  headers: { 'List-Unsubscribe': '<https://app.example.com/u>' },
  tags: { kind: 'DIGEST_DAILY' },
  idempotencyKey: 'digest:abc',
}

const reply = (status: number, body: unknown = { id: 'em_1' }) => vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }))

describe('ResendEmail', () => {
  it('posts the message to Resend with the key, the sender and the idempotency key', async () => {
    const fetcher = reply(200)
    const sent = await new ResendEmail({ apiKey: 're_key', from: 'App <hi@example.com>', replyTo: 'help@example.com' }, fetcher).send(message)
    expect(sent).toEqual({ id: 'em_1' })
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }]
    expect(url).toBe('https://api.resend.com/emails')
    expect(init.headers.Authorization).toBe('Bearer re_key')
    expect(init.headers['Idempotency-Key']).toBe('digest:abc')
    expect(JSON.parse(init.body)).toMatchObject({
      from: 'App <hi@example.com>',
      to: ['ada@example.com'],
      subject: 'Hello',
      reply_to: 'help@example.com',
      headers: { 'List-Unsubscribe': '<https://app.example.com/u>' },
      tags: [{ name: 'kind', value: 'DIGEST_DAILY' }],
    })
  })

  it('treats a rate limit and a provider outage as worth retrying, and a refusal as final', async () => {
    const send = (status: number) => new ResendEmail({ apiKey: 're_key', from: 'hi@example.com' }, reply(status)).send(message)
    for (const status of [429, 500, 503]) await expect(send(status)).rejects.toMatchObject({ name: 'EmailSendError', retryable: true })
    for (const status of [400, 401, 403, 422]) await expect(send(status)).rejects.toMatchObject({ name: 'EmailSendError', retryable: false })
  })

  it('treats a network failure as worth retrying, without echoing the address or the key', async () => {
    const failing = vi.fn(async () => {
      throw new TypeError('fetch failed for ada@example.com with re_key')
    })
    const error = await new ResendEmail({ apiKey: 're_key', from: 'hi@example.com' }, failing).send(message).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(EmailSendError)
    expect((error as EmailSendError).retryable).toBe(true)
    expect((error as EmailSendError).message).not.toContain('ada@example.com')
    expect((error as EmailSendError).message).not.toContain('re_key')
  })

  it('treats an answer without a message id as an error, because a bounce could not be matched to it', async () => {
    await expect(new ResendEmail({ apiKey: 're_key', from: 'hi@example.com' }, reply(200, {})).send(message)).rejects.toMatchObject({ retryable: true })
  })
})

describe('MemoryEmail', () => {
  it('keeps what was sent, by address', async () => {
    const email = new MemoryEmail()
    await email.send(message)
    await email.send({ ...message, to: 'grace@example.com', idempotencyKey: undefined })
    expect(email.outbox).toHaveLength(2)
    expect(email.to('ADA@example.com')).toHaveLength(1)
  })

  it('delivers a message with the same idempotency key once', async () => {
    const email = new MemoryEmail()
    const first = await email.send(message)
    const second = await email.send(message)
    expect(second.id).toBe(first.id)
    expect(email.outbox).toHaveLength(1)
  })

  it('fails for an address it was told to, retryably or not', async () => {
    const email = new MemoryEmail()
    email.failFor('bad@example.com')
    email.failFor('slow@example.com', true)
    await expect(email.send({ ...message, to: 'bad@example.com' })).rejects.toMatchObject({ retryable: false })
    await expect(email.send({ ...message, to: 'slow@example.com' })).rejects.toMatchObject({ retryable: true })
    expect(email.outbox).toHaveLength(0)
  })
})

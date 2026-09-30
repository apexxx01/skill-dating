import { describe, it, expect, vi } from 'vitest'
import type { User as ClerkUser } from '@clerk/nextjs/server'
import { processClerkEvent, type WebhookDeps } from './clerk-webhook'
import { AccountConflictError } from './user-sync'

const clerkUser = { id: 'user_abc' } as ClerkUser

function deps(over: Partial<WebhookDeps> = {}): WebhookDeps {
  return {
    fetchUser: vi.fn(async () => clerkUser),
    sync: vi.fn(async () => undefined),
    tombstone: vi.fn(async () => true),
    ...over,
  }
}

describe('processClerkEvent', () => {
  it('re-fetches the user and syncs on created and updated', async () => {
    for (const type of ['user.created', 'user.updated']) {
      const d = deps()
      expect(await processClerkEvent({ type, data: { id: 'user_abc' } }, d)).toEqual({ status: 'synced' })
      expect(d.fetchUser).toHaveBeenCalledWith('user_abc')
      expect(d.sync).toHaveBeenCalledWith(clerkUser)
      expect(d.tombstone).not.toHaveBeenCalled()
    }
  })

  it('never trusts the payload body beyond the id', async () => {
    const d = deps()
    await processClerkEvent({ type: 'user.updated', data: { id: 'user_abc', email_addresses: [{ email_address: 'evil@x.dev' }] } as never }, d)
    expect(d.sync).toHaveBeenCalledWith(clerkUser)
  })

  it('tombstones on deleted without calling Clerk', async () => {
    const d = deps()
    expect(await processClerkEvent({ type: 'user.deleted', data: { id: 'user_abc' } }, d)).toEqual({ status: 'tombstoned', found: true })
    expect(d.fetchUser).not.toHaveBeenCalled()
  })

  it('reports found=false when there is no local row to tombstone (replay)', async () => {
    const d = deps({ tombstone: vi.fn(async () => false) })
    expect(await processClerkEvent({ type: 'user.deleted', data: { id: 'user_abc' } }, d)).toEqual({ status: 'tombstoned', found: false })
  })

  it('tombstones instead of syncing when a stale created/updated event arrives after deletion', async () => {
    const d = deps({ fetchUser: vi.fn(async () => { throw Object.assign(new Error('gone'), { status: 404 }) }) })
    expect(await processClerkEvent({ type: 'user.updated', data: { id: 'user_abc' } }, d)).toEqual({ status: 'tombstoned', found: true })
    expect(d.sync).not.toHaveBeenCalled()
  })

  it('answers conflict, not an error, when the email belongs to another account', async () => {
    const d = deps({ sync: vi.fn(async () => { throw new AccountConflictError() }) })
    expect(await processClerkEvent({ type: 'user.created', data: { id: 'user_abc' } }, d)).toEqual({ status: 'conflict' })
  })

  it('lets transient failures propagate so Clerk retries', async () => {
    const d = deps({ sync: vi.fn(async () => { throw new Error('db down') }) })
    await expect(processClerkEvent({ type: 'user.created', data: { id: 'user_abc' } }, d)).rejects.toThrow('db down')
    const e = deps({ fetchUser: vi.fn(async () => { throw Object.assign(new Error('rate'), { status: 429 }) }) })
    await expect(processClerkEvent({ type: 'user.created', data: { id: 'user_abc' } }, e)).rejects.toThrow('rate')
  })

  it('ignores other event types and events without a user id', async () => {
    const d = deps()
    expect((await processClerkEvent({ type: 'session.created', data: { id: 'sess_1' } }, d)).status).toBe('ignored')
    expect((await processClerkEvent({ type: 'user.created', data: {} }, d)).status).toBe('ignored')
    expect((await processClerkEvent({}, d)).status).toBe('ignored')
    expect(d.fetchUser).not.toHaveBeenCalled()
    expect(d.tombstone).not.toHaveBeenCalled()
  })
})

import { describe, it, expect, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { applyVerification, atLeast } from './verification'

interface Row {
  verificationLevel: string
  isEmailVerified: boolean
  isPhoneVerified: boolean
  githubConnected: boolean
}

function fakeTx(initial: Partial<Row> = {}, verifications: { id: string; type: string; status: string }[] = []) {
  const user: Row = { verificationLevel: 'NONE', isEmailVerified: false, isPhoneVerified: false, githubConnected: false, ...initial }
  const updates: Record<string, unknown>[] = []
  const created: Record<string, unknown>[] = []
  const tx = {
    user: {
      findUnique: vi.fn(async () => user),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data)
      }),
    },
    verification: {
      findFirst: vi.fn(async ({ where }: { where: { type: string } }) => verifications.find((row) => row.type === where.type) ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data)
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updates.push({ verification: data })
      }),
    },
  }
  return { tx: tx as unknown as Prisma.TransactionClient, updates, created }
}

describe('applyVerification: phone', () => {
  it('marks a verified phone, lifts the level to PHONE and records the verification', async () => {
    const { tx, updates, created } = fakeTx({ verificationLevel: 'EMAIL', isEmailVerified: true })
    await applyVerification(tx, 'u1', { emailVerified: true, githubConnected: false, phoneVerified: true })
    expect(updates).toEqual([{ verificationLevel: 'PHONE', isPhoneVerified: true }])
    expect(created).toEqual([expect.objectContaining({ userId: 'u1', type: 'PHONE', status: 'VERIFIED', provider: 'clerk' })])
  })

  it('does nothing about a phone when Clerk has none, which is also what an instance with phone numbers switched off reports', async () => {
    const { tx, updates, created } = fakeTx({ verificationLevel: 'EMAIL', isEmailVerified: true })
    await applyVerification(tx, 'u1', { emailVerified: true, githubConnected: false, phoneVerified: false })
    await applyVerification(tx, 'u1', { emailVerified: true, githubConnected: false })
    expect(updates).toEqual([])
    expect(created).toEqual([])
  })

  it('never lowers the level: a phone does not undo GitHub', async () => {
    const { tx, updates } = fakeTx({ verificationLevel: 'GITHUB', isEmailVerified: true, githubConnected: true })
    await applyVerification(tx, 'u1', { emailVerified: true, githubConnected: true, phoneVerified: true })
    expect(updates).toEqual([{ isPhoneVerified: true }])
  })

  it('keeps what a phone proved when it is later removed in Clerk', async () => {
    const { tx, updates } = fakeTx({ verificationLevel: 'PHONE', isEmailVerified: true, isPhoneVerified: true })
    await applyVerification(tx, 'u1', { emailVerified: true, githubConnected: false, phoneVerified: false })
    expect(updates).toEqual([])
  })

  it('repairs a verification row that was left unverified and does not duplicate one that is fine', async () => {
    const repaired = fakeTx({ isPhoneVerified: true, verificationLevel: 'PHONE' }, [{ id: 'v1', type: 'PHONE', status: 'PENDING' }])
    await applyVerification(repaired.tx, 'u1', { emailVerified: false, githubConnected: false, phoneVerified: true })
    expect(repaired.created).toEqual([])
    expect(repaired.updates).toEqual([{ verification: expect.objectContaining({ status: 'VERIFIED' }) }])

    const fine = fakeTx({ isPhoneVerified: true, verificationLevel: 'PHONE' }, [{ id: 'v1', type: 'PHONE', status: 'VERIFIED' }])
    await applyVerification(fine.tx, 'u1', { emailVerified: false, githubConnected: false, phoneVerified: true })
    expect(fine.created).toEqual([])
    expect(fine.updates).toEqual([])
  })

  it('orders PHONE between EMAIL and GITHUB', () => {
    expect(atLeast('EMAIL', 'PHONE')).toBe('PHONE')
    expect(atLeast('GITHUB', 'PHONE')).toBe('GITHUB')
  })
})

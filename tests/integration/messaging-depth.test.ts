import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { req, registerAndLogin, uniqueSuffix, type TestUser } from './helpers'
import { cleanupTestUsers, testPrisma } from './db'
import { INTEGRATION_DATABASE_URL } from './config'
import { unreadCountsByConversation } from '@/lib/messaging'

const BCRYPT = /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/

describe('messaging depth: read receipts, unread counts, reactions', () => {
  const suffix = uniqueSuffix()
  let A: TestUser
  let B: TestUser
  let C: TestUser
  let emailA: string
  let emailB: string
  let conversationId: string

  async function addMessage(senderId: string, content: string, createdAt: Date, extra: { deletedAt?: Date } = {}) {
    return testPrisma.message.create({
      data: { conversationId, senderId, content, createdAt, ...extra },
    })
  }

  const unreadFor = async (user: TestUser) => {
    const res = await req(user.jar, 'GET', '/api/conversations')
    const conv = res.data.conversations.find((c: any) => c.id === conversationId)
    return { conv, total: res.data.totalUnread as number }
  }

  beforeAll(async () => {
    emailA = `msgdepth.a.${suffix}@test.dev`
    emailB = `msgdepth.b.${suffix}@test.dev`
    A = await registerAndLogin(emailA, `msgdeptha${suffix}`)
    B = await registerAndLogin(emailB, `msgdepthb${suffix}`)
    C = await registerAndLogin(`msgdepth.c.${suffix}@test.dev`, `msgdepthc${suffix}`)

    const created = await req(A.jar, 'POST', '/api/conversations', { type: 'DIRECT', participantIds: [B.userId] })
    expect(created.status).toBe(201)
    conversationId = created.data.id
  })

  afterAll(async () => {
    await cleanupTestUsers(suffix)
  })

  describe('unread counts', () => {
    it('counts only other people\'s, non-deleted messages, per user', async () => {
      const t = Date.now() - 60_000
      await addMessage(B.userId, 'b1', new Date(t))
      await addMessage(B.userId, 'b2', new Date(t + 1000))
      await addMessage(B.userId, 'b-deleted', new Date(t + 2000), { deletedAt: new Date() })
      await addMessage(A.userId, 'a1 (own)', new Date(t + 3000))

      const forA = await unreadFor(A)
      expect(forA.conv.unreadCount).toBe(2) // b1, b2; not own, not deleted
      expect(forA.total).toBe(2)

      const forB = await unreadFor(B)
      expect(forB.conv.unreadCount).toBe(1) // only A's message
      expect(forB.total).toBe(1)
    })

    it('returns correct per-conversation and total counts across several conversations', async () => {
      const extraIds: string[] = []
      for (let i = 0; i < 4; i++) {
        const other = await registerAndLogin(`msgdepth.x${i}.${suffix}@test.dev`, `msgdepthx${i}${suffix}`)
        const created = await req(other.jar, 'POST', '/api/conversations', { type: 'DIRECT', participantIds: [A.userId] })
        expect(created.status).toBe(201)
        extraIds.push(created.data.id)
        for (let k = 0; k <= i; k++) {
          await testPrisma.message.create({
            data: { conversationId: created.data.id, senderId: other.userId, content: `x${i}-${k}` },
          })
        }
      }

      const res = await req(A.jar, 'GET', '/api/conversations?limit=50')
      expect(res.status).toBe(200)
      const byId = new Map<string, number>(res.data.conversations.map((c: any) => [c.id, c.unreadCount]))
      extraIds.forEach((id, i) => expect(byId.get(id)).toBe(i + 1))
      expect(byId.get(conversationId)).toBe(2)
      expect(res.data.totalUnread).toBe(2 + 1 + 2 + 3 + 4)
    })

    it('computes counts for many conversations in exactly one query', async () => {
      const logged = new PrismaClient({
        datasources: { db: { url: INTEGRATION_DATABASE_URL } },
        log: [{ emit: 'event', level: 'query' }],
      })
      const queries: string[] = []
      ;(logged as any).$on('query', (event: { query: string }) => queries.push(event.query))
      try {
        const convs = await logged.conversationMember.findMany({ where: { userId: A.userId }, select: { conversationId: true } })
        expect(convs.length).toBeGreaterThanOrEqual(5)
        queries.length = 0
        const counts = await unreadCountsByConversation(logged, A.userId, convs.map((c) => c.conversationId))
        expect(counts.size).toBeGreaterThanOrEqual(5)
        expect(queries.filter((q) => q.includes('"MessageRead"')).length).toBe(1)
        expect(queries.length).toBe(1)
      } finally {
        await logged.$disconnect()
      }
    })
  })

  describe('mark read', () => {
    it('rejects a non-member (403) and an unknown conversation (404)', async () => {
      expect((await req(C.jar, 'POST', `/api/conversations/${conversationId}/read`, {})).status).toBe(403)
      expect((await req(A.jar, 'POST', '/api/conversations/not-a-real-conversation/read', {})).status).toBe(404)
    })

    it('rejects an upToMessageId from another conversation', async () => {
      const other = await req(B.jar, 'POST', '/api/conversations', { type: 'DIRECT', participantIds: [C.userId] })
      const foreign = await testPrisma.message.create({
        data: { conversationId: other.data.id, senderId: C.userId, content: 'foreign' },
      })
      const res = await req(A.jar, 'POST', `/api/conversations/${conversationId}/read`, { upToMessageId: foreign.id })
      expect(res.status).toBe(400)
      expect((await req(A.jar, 'POST', `/api/conversations/${conversationId}/read`, { upToMessageId: 'nope' })).status).toBe(400)
    })

    it('marks only up to the given message, then everything, and is idempotent', async () => {
      const messages = await testPrisma.message.findMany({
        where: { conversationId, senderId: B.userId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
      })
      expect(messages.length).toBe(2)

      const partial = await req(A.jar, 'POST', `/api/conversations/${conversationId}/read`, { upToMessageId: messages[0].id })
      expect(partial.status).toBe(200)
      expect(partial.data).toMatchObject({ conversationId, readCount: 1, unreadCount: 1 })

      const all = await req(A.jar, 'POST', `/api/conversations/${conversationId}/read`)
      expect(all.data).toMatchObject({ readCount: 1, unreadCount: 0 })

      const again = await req(A.jar, 'POST', `/api/conversations/${conversationId}/read`, {})
      expect(again.data).toMatchObject({ readCount: 0, unreadCount: 0 })

      const member = await testPrisma.conversationMember.findUnique({
        where: { userId_conversationId: { userId: A.userId, conversationId } },
      })
      expect(member?.lastReadAt).toBeTruthy()

      // Recipient B is unaffected by A's reads.
      expect((await unreadFor(B)).conv.unreadCount).toBe(1)
      // A's own and deleted messages never produced read rows.
      const rows = await testPrisma.messageRead.count({ where: { userId: A.userId, message: { conversationId } } })
      expect(rows).toBe(2)
    })

    it('handles concurrent mark-read calls without errors or duplicates', async () => {
      await addMessage(B.userId, 'concurrent 1', new Date())
      await addMessage(B.userId, 'concurrent 2', new Date())
      const results = await Promise.all(
        Array.from({ length: 5 }, () => req(A.jar, 'POST', `/api/conversations/${conversationId}/read`, {}))
      )
      expect(results.every((r) => r.status === 200)).toBe(true)
      expect(results.reduce((sum, r) => sum + r.data.readCount, 0)).toBe(2)
      expect((await unreadFor(A)).conv.unreadCount).toBe(0)
    })
  })

  describe('opening a conversation', () => {
    it('marks only the returned page as read, not newer unseen messages', async () => {
      // A pair with no earlier conversation (DIRECT conversations are deduped
      // per pair, and the other tests already put a message in B and C's).
      const D = await registerAndLogin(`msgdepth.d.${suffix}@test.dev`, `msgdepthd${suffix}`)
      const fresh = await req(D.jar, 'POST', '/api/conversations', { type: 'DIRECT', participantIds: [C.userId] })
      const id = fresh.data.id
      const base = Date.now() - 120_000
      const ids: string[] = []
      for (let i = 0; i < 5; i++) {
        const m = await testPrisma.message.create({
          data: { conversationId: id, senderId: D.userId, content: `page-${i}`, createdAt: new Date(base + i * 1000) },
        })
        ids.push(m.id)
      }
      const unread = async () => {
        const list = await req(C.jar, 'GET', '/api/conversations?limit=50')
        return list.data.conversations.find((c: any) => c.id === id).unreadCount as number
      }
      expect(await unread()).toBe(5)

      // Newest two messages.
      const first = await req(C.jar, 'GET', `/api/conversations/${id}?limit=2&page=1`)
      expect(first.data.messages.length).toBe(2)
      expect(await unread()).toBe(3)

      // Oldest page (page 3 of size 2 holds only the oldest message); the
      // middle two, which this response did not return, stay unread.
      const oldest = await req(C.jar, 'GET', `/api/conversations/${id}?limit=2&page=3`)
      expect(oldest.data.messages.length).toBe(1)
      expect(await unread()).toBe(2)

      const readIds = (await testPrisma.messageRead.findMany({ where: { userId: C.userId, messageId: { in: ids } } })).map((r) => r.messageId)
      expect(new Set(readIds)).toEqual(new Set([ids[4], ids[3], ids[0]]))
    })
  })

  describe('reactions', () => {
    let messageId: string
    let deletedId: string

    beforeAll(async () => {
      messageId = (await addMessage(B.userId, 'react to me', new Date())).id
      deletedId = (await addMessage(B.userId, 'gone', new Date(), { deletedAt: new Date() })).id
    })

    it('toggles on and off with counts and reactedByMe', async () => {
      const on = await req(A.jar, 'POST', `/api/messages/${messageId}/reactions`, { emoji: '👍' })
      expect(on.status).toBe(200)
      expect(on.data.reacted).toBe(true)
      expect(on.data.reactions).toEqual([{ emoji: '👍', count: 1, reactedByMe: true }])

      const other = await req(B.jar, 'POST', `/api/messages/${messageId}/reactions`, { emoji: '👍' })
      expect(other.data.reactions).toEqual([{ emoji: '👍', count: 2, reactedByMe: true }])

      const seenByA = await req(A.jar, 'GET', `/api/messages/${messageId}/reactions`)
      expect(seenByA.data.reactions).toEqual([{ emoji: '👍', count: 2, reactedByMe: true }])

      const off = await req(A.jar, 'POST', `/api/messages/${messageId}/reactions`, { emoji: '👍' })
      expect(off.data.reacted).toBe(false)
      expect(off.data.reactions).toEqual([{ emoji: '👍', count: 1, reactedByMe: false }])
    })

    it('rejects non-members (403), missing messages (404) and deleted messages (400)', async () => {
      expect((await req(C.jar, 'POST', `/api/messages/${messageId}/reactions`, { emoji: '👍' })).status).toBe(403)
      expect((await req(C.jar, 'GET', `/api/messages/${messageId}/reactions`)).status).toBe(403)
      expect((await req(A.jar, 'POST', '/api/messages/does-not-exist/reactions', { emoji: '👍' })).status).toBe(404)
      expect((await req(A.jar, 'POST', `/api/messages/${deletedId}/reactions`, { emoji: '👍' })).status).toBe(400)
    })

    it('rejects anything that is not a short emoji', async () => {
      for (const emoji of ['hello', '', '1', '😀a', '<b>', '👍'.repeat(20), '\u0000😀']) {
        const res = await req(A.jar, 'POST', `/api/messages/${messageId}/reactions`, { emoji })
        expect(res.status, JSON.stringify(emoji)).toBe(400)
      }
      expect((await req(A.jar, 'POST', `/api/messages/${messageId}/reactions`, {})).status).toBe(400)
      expect((await req(A.jar, 'POST', `/api/messages/${messageId}/reactions`, { emoji: 5 })).status).toBe(400)
    })

    it('never returns a 500 for parallel toggles and ends consistent', async () => {
      const target = (await addMessage(B.userId, 'parallel', new Date())).id
      const results = await Promise.all(
        Array.from({ length: 8 }, () => req(A.jar, 'POST', `/api/messages/${target}/reactions`, { emoji: '🎉' }))
      )
      expect(results.every((r) => r.status === 200)).toBe(true)
      const rows = await testPrisma.messageReaction.count({ where: { messageId: target, userId: A.userId, emoji: '🎉' } })
      expect(rows).toBeLessThanOrEqual(1)
      const summary = await req(A.jar, 'GET', `/api/messages/${target}/reactions`)
      const mine = summary.data.reactions.find((r: any) => r.emoji === '🎉')
      expect(Boolean(mine?.reactedByMe)).toBe(rows === 1)
    })

    it('caps distinct emoji per user (10) and per message (30)', async () => {
      const target = (await addMessage(B.userId, 'caps', new Date())).id
      const emoji = (i: number) => String.fromCodePoint(0x1f600 + i)

      for (let i = 0; i < 10; i++) {
        const res = await req(A.jar, 'POST', `/api/messages/${target}/reactions`, { emoji: emoji(i) })
        expect(res.status, `reaction ${i}`).toBe(200)
      }
      const eleventh = await req(A.jar, 'POST', `/api/messages/${target}/reactions`, { emoji: emoji(10) })
      expect(eleventh.status).toBe(400)
      // Removing one frees a slot.
      expect((await req(A.jar, 'POST', `/api/messages/${target}/reactions`, { emoji: emoji(0) })).data.reacted).toBe(false)
      expect((await req(A.jar, 'POST', `/api/messages/${target}/reactions`, { emoji: emoji(10) })).status).toBe(200)

      // Fill the message to 30 distinct emoji using other (seeded) users.
      const seeded: { id: string }[] = []
      for (let u = 0; u < 3; u++) {
        seeded.push(
          await testPrisma.user.create({
            data: { email: `msgdepth.seed${u}.${suffix}@test.dev`, username: `msgdepthseed${u}${suffix}` },
          })
        )
      }
      const existing = new Set(
        (await testPrisma.messageReaction.findMany({ where: { messageId: target }, select: { emoji: true } })).map((r) => r.emoji)
      )
      const toAdd: string[] = []
      for (let i = 100; existing.size + toAdd.length < 30; i++) toAdd.push(emoji(i))
      await testPrisma.messageReaction.createMany({
        data: toAdd.map((e, i) => ({ messageId: target, userId: seeded[i % 3].id, emoji: e })),
      })

      const overflow = await req(A.jar, 'POST', `/api/messages/${target}/reactions`, { emoji: emoji(500) })
      expect(overflow.status).toBe(400)
      // Joining an emoji that already exists on the message is still allowed.
      const join = await req(B.jar, 'POST', `/api/messages/${target}/reactions`, { emoji: emoji(1) })
      expect(join.status).toBe(200)
    })
  })

  it('never exposes emails or password hashes', async () => {
    const paths = [
      ['GET', '/api/conversations'],
      ['GET', `/api/conversations/${conversationId}`],
    ] as const
    for (const [method, path] of paths) {
      const res = await req(A.jar, method, path)
      const body = JSON.stringify(res.data)
      expect(body).not.toContain('passwordHash')
      expect(body).not.toMatch(BCRYPT)
      expect(body).not.toContain(emailB)
    }
    const message = await testPrisma.message.findFirst({ where: { conversationId } })
    const reaction = await req(A.jar, 'POST', `/api/messages/${message!.id}/reactions`, { emoji: '🔥' })
    const body = JSON.stringify(reaction.data)
    expect(body).not.toContain('@test.dev')
    expect(body).not.toContain('passwordHash')
  })
})

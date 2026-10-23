import type { PrismaClient } from '@prisma/client'
import { adultNoticeDue, adultNoticeWindow, wasMinorAt } from '@/lib/age-policy'

// The one-time note on the 18th birthday of someone who was a minor on the platform: their share cards are still off (src/lib/birth-date.ts keepCardsOff), and here is what
// the switch is. It is for people who were under 18 when their account was made (or are told so by their date of birth), not for someone who joined as an adult. It is sent
// from the birthday on the person's own calendar (and not before the UTC calendar the age policy counts in has reached it too), and a job that was down for a few days
// catches up. It is written once: a notification keyed `cards:adult` per person, which the database allows only once (Notification.userId + coalesceKey).

type Db = Pick<PrismaClient, 'user' | 'notification'>

export const CARDS_ADULT_KEY = 'cards:adult'
const BATCH = 500

export const cardsAdultNotice = {
  title: 'You are 18: your share cards are still off',
  message:
    'The preview pictures that appear when someone shares a link to your passport, a post or a squad were never public while you were under 18, and they stay off until you decide. You can turn them on any time in your privacy settings.',
  link: '/settings/privacy',
} as const

export interface CardsNoticeResult {
  checked: number
  notified: number
}

export async function runAdultCardsNotice(db: Db, now: Date = new Date()): Promise<CardsNoticeResult> {
  const { from, to } = adultNoticeWindow(now)
  const result: CardsNoticeResult = { checked: 0, notified: 0 }
  let after: string | undefined
  for (;;) {
    const people = await db.user.findMany({
      where: { birthDate: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) }, deletedAt: null, birthDateRefusedAt: null, ...(after ? { id: { gt: after } } : {}) },
      select: { id: true, birthDate: true, createdAt: true, timezone: true },
      orderBy: { id: 'asc' },
      take: BATCH,
    })
    if (people.length === 0) break
    after = people[people.length - 1].id
    const due = people.filter((person) => person.birthDate && wasMinorAt(person.birthDate, person.createdAt) && adultNoticeDue(person.birthDate, person.timezone, now))
    result.checked += people.length
    if (due.length > 0) {
      const written = await db.notification.createMany({
        data: due.map((person) => ({
          userId: person.id,
          type: 'SYSTEM' as const,
          title: cardsAdultNotice.title,
          message: cardsAdultNotice.message,
          link: cardsAdultNotice.link,
          coalesceKey: CARDS_ADULT_KEY,
          createdAt: now,
          metadata: { kind: 'CARDS_ADULT' },
        })),
        skipDuplicates: true,
      })
      result.notified += written.count
    }
    if (people.length < BATCH) break
  }
  return result
}

export async function runAdultCardsNoticeJob(): Promise<CardsNoticeResult> {
  const { prisma } = await import('@/lib/prisma')
  return runAdultCardsNotice(prisma)
}

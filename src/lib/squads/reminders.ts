import type { Prisma, PrismaClient } from '@prisma/client'
import { KIND_SPECS } from '@/lib/notification-kinds'
import { deliverSoon } from '@/lib/notify/immediate'

// Reminders to people registered for a hackathon who have no squad yet (docs/SQUADS.md, "Lifecycle"): a week before the registration deadline, at
// two days (when the solo pool forms its squads) and at one day. Each stage is sent once per person (Notification.coalesceKey
// `squad-reminder:<hackathon>:<stage>`, unique per person, so a rerun writes nothing), and nobody who switched SQUAD_REMINDER off gets one. Run by
// the hourly squad sweep; a stage that was missed because the sweep did not run is sent late, never a stage that has passed.

type Db = PrismaClient

const HOUR_MS = 60 * 60 * 1000

export type ReminderStage = 'T7D' | 'T48H' | 'T24H'

/** Each stage starts this long before the deadline; it lasts until the next stage starts (the last one until the deadline). */
export const REMINDER_STAGES: readonly { stage: ReminderStage; beforeMs: number }[] = [
  { stage: 'T7D', beforeMs: 7 * 24 * HOUR_MS },
  { stage: 'T48H', beforeMs: 48 * HOUR_MS },
  { stage: 'T24H', beforeMs: 24 * HOUR_MS },
]

/** Which reminder is due `now` for a hackathon whose teams must be formed by `deadline`, or null (too early, or past the deadline). Pure. */
export function reminderStageAt(deadline: Date, now: Date): ReminderStage | null {
  const left = deadline.getTime() - now.getTime()
  if (left <= 0) return null
  let due: ReminderStage | null = null
  for (const { stage, beforeMs } of REMINDER_STAGES) if (left <= beforeMs) due = stage
  return due
}

const MESSAGES: Record<ReminderStage, (name: string) => string> = {
  T7D: (name) => `${name} closes registration in a week and you have no squad yet: try Find my squad or the looking-for-group board`,
  T48H: (name) => `Two days left to find a squad for ${name}: the solo pool is forming squads now if you are open to one`,
  T24H: (name) => `Last day to find a squad for ${name}`,
}

/** Sends the reminder that is due now, for every hackathon that has one due, to its teamless registrants. Returns how many were written. */
export async function sendSquadReminders(db: Db, now: Date = new Date()): Promise<number> {
  const horizon = new Date(now.getTime() + REMINDER_STAGES[0].beforeMs)
  const hackathons = await db.hackathon.findMany({
    where: {
      status: { in: ['UPCOMING', 'ACTIVE'] },
      OR: [{ registrationDeadline: { gt: now, lte: horizon } }, { registrationDeadline: null, startDate: { gt: now, lte: horizon } }],
    },
    select: { id: true, name: true, slug: true, registrationDeadline: true, startDate: true },
    take: 500,
  })
  let written = 0
  for (const hackathon of hackathons) {
    const stage = reminderStageAt(hackathon.registrationDeadline ?? hackathon.startDate, now)
    if (!stage) continue
    const coalesceKey = `squad-reminder:${hackathon.id}:${stage}`
    let after: string | undefined
    for (;;) {
      const batch = await db.hackathonParticipant.findMany({
        where: { hackathonId: hackathon.id, teamId: null, status: { not: 'WITHDRAWN' }, ...(after ? { id: { gt: after } } : {}), user: { deletedAt: null } },
        orderBy: { id: 'asc' },
        take: 500,
        select: { id: true, userId: true },
      })
      if (batch.length === 0) break
      after = batch[batch.length - 1].id
      const ids = batch.map((row) => row.userId)
      const [muted, members] = await Promise.all([
        db.notificationPreference.findMany({ where: { userId: { in: ids }, kind: 'SQUAD_REMINDER', enabled: false }, select: { userId: true } }),
        db.teamMember.findMany({ where: { userId: { in: ids }, team: { hackathonId: hackathon.id } }, select: { userId: true } }),
      ])
      const skip = new Set([...muted, ...members].map((row) => row.userId))
      const data: Prisma.NotificationCreateManyInput[] = ids
        .filter((id) => !skip.has(id))
        .map((userId) => ({
          userId,
          type: KIND_SPECS.SQUAD_REMINDER.type,
          title: 'Find your squad',
          message: MESSAGES[stage](hackathon.name),
          link: `/hackathons/${hackathon.slug}`,
          metadata: { kind: 'SQUAD_REMINDER', hackathonId: hackathon.id, stage },
          coalesceKey,
          count: 1,
        }))
      if (data.length > 0) {
        const count = (await db.notification.createMany({ data, skipDuplicates: true })).count
        written += count
        // The last reminder, a day before registration closes, is time-critical: dispatched now, not at the next sweep (src/lib/notify/immediate.ts).
        if (count > 0 && stage === 'T24H') deliverSoon(db, data.map((row) => row.userId))
      }
      if (batch.length < 500) break
    }
  }
  return written
}

import type { Notification, Prisma, PrismaClient } from '@prisma/client'
import { KIND_SPECS, NOTIFICATION_KINDS, type NotificationKind } from './notification-kinds'

// Writing notifications while respecting what each person has switched off. Everything that creates a notification for ANOTHER person because of what
// somebody did (a spark, a prop, a comment, a follow) goes through createNotification(); notifications about one's own account (a level-up, a quest) are not
// switchable and are written directly.

type Db = PrismaClient | Prisma.TransactionClient

/** The kinds this person has switched OFF. */
export async function mutedKinds(db: Pick<Db, 'notificationPreference'>, userId: string): Promise<Set<NotificationKind>> {
  const rows = await db.notificationPreference.findMany({ where: { userId, enabled: false }, select: { kind: true } })
  return new Set(rows.map((row) => row.kind as NotificationKind))
}

/** Every kind with whether it is on for this person (on unless a row says off). */
export async function loadPreferences(db: Pick<Db, 'notificationPreference'>, userId: string): Promise<Record<NotificationKind, boolean>> {
  const muted = await mutedKinds(db, userId)
  return Object.fromEntries(NOTIFICATION_KINDS.map((kind) => [kind, !muted.has(kind)])) as Record<NotificationKind, boolean>
}

export async function wantsNotification(db: Pick<Db, 'notificationPreference'>, userId: string, kind: NotificationKind): Promise<boolean> {
  const row = await db.notificationPreference.findUnique({ where: { userId_kind: { userId, kind } }, select: { enabled: true } })
  return row?.enabled !== false
}

/** Switches kinds on or off, for the kinds named; the others keep what they were. Returns the whole picture. */
export async function savePreferences(db: Db, userId: string, changes: Partial<Record<NotificationKind, boolean>>): Promise<Record<NotificationKind, boolean>> {
  for (const [kind, enabled] of Object.entries(changes) as [NotificationKind, boolean][]) {
    await db.notificationPreference.upsert({ where: { userId_kind: { userId, kind } }, create: { userId, kind, enabled }, update: { enabled } })
  }
  return loadPreferences(db, userId)
}

export interface NotifyInput {
  userId: string
  kind: NotificationKind
  title: string
  message: string
  link?: string
  /** Stored with the notification; the kind is added to it. Never personal data beyond ids. */
  metadata?: Record<string, unknown>
}

/** Creates a notification unless the person has switched this kind off. Returns the notification, or null when it was not written. */
export async function createNotification(db: Db, input: NotifyInput): Promise<Notification | null> {
  if (!(await wantsNotification(db, input.userId, input.kind))) return null
  return db.notification.create({
    data: {
      userId: input.userId,
      type: KIND_SPECS[input.kind].type,
      title: input.title,
      message: input.message,
      link: input.link,
      metadata: { kind: input.kind, ...(input.metadata ?? {}) } as Prisma.InputJsonValue,
    },
  })
}

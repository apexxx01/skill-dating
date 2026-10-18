import type { NotificationType } from '@prisma/client'
import { ROMANCE_MODE_LABEL } from '@/lib/romance/config'

// The kinds of notification a person can switch off, one by one. A "kind" is finer than the stored `NotificationType` (which is what the interface filters by): several
// kinds can share a type (a spark and the daily count of sparks are both SPARK). Pure data, shared by the preferences route, the writers and the tests.

export const NOTIFICATION_KINDS = ['SPARK', 'SPARK_DIGEST', 'ROMANCE_DROP'] as const
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]

export interface KindSpec {
  type: NotificationType
  /** What the setting is called in a list of switches. */
  label: string
}

export const KIND_SPECS: Record<NotificationKind, KindSpec> = {
  SPARK: { type: 'SPARK', label: 'Someone sparked you (each spark, with who)' },
  SPARK_DIGEST: { type: 'SPARK', label: 'A daily count of the people who sparked you' },
  ROMANCE_DROP: { type: 'SYSTEM', label: `Your ${ROMANCE_MODE_LABEL} pick for the week` },
}

export const isNotificationKind = (value: unknown): value is NotificationKind => typeof value === 'string' && (NOTIFICATION_KINDS as readonly string[]).includes(value)

import type { NotificationType } from '@prisma/client'
import { ROMANCE_MODE_LABEL } from '@/lib/romance/config'

// The kinds of notification a person can switch off, one by one. A "kind" is finer than the stored `NotificationType` (which is what the interface filters by): several
// kinds can share a type (a spark and the daily count of sparks are both SPARK). Pure data, shared by the preferences route, the writers and the tests.

export const NOTIFICATION_KINDS = ['SPARK', 'SPARK_DIGEST', 'ROMANCE_DROP', 'ROMANCE_SPARK', 'ROMANCE_SPARK_DIGEST', 'ROMANCE_REVEAL', 'ROMANCE_DUO', 'PROPS', 'COMMENT', 'FOLLOW', 'WATCH', 'SQUAD_INVITE', 'SQUAD_PROPOSAL', 'SQUAD_REMINDER', 'SQUAD_UPDATE', 'PEER_REVIEW'] as const
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
  ROMANCE_SPARK: { type: 'SPARK', label: `Someone sparked you in ${ROMANCE_MODE_LABEL} (each spark, with who)` },
  ROMANCE_REVEAL: { type: 'SYSTEM', label: `Photo reveal requests in ${ROMANCE_MODE_LABEL}` },
  ROMANCE_DUO: { type: 'SYSTEM', label: `Duo invitations in ${ROMANCE_MODE_LABEL}` },
  PROPS: { type: 'PROPS', label: 'Props on your posts' },
  COMMENT: { type: 'COMMENT', label: 'Comments and replies' },
  FOLLOW: { type: 'FOLLOW', label: 'New followers' },
  WATCH: { type: 'WATCH', label: 'Posts on projects you watch' },
  ROMANCE_SPARK_DIGEST: { type: 'SPARK', label: `A daily count of the people who sparked you in ${ROMANCE_MODE_LABEL}` },
  SQUAD_INVITE: { type: 'TEAM_INVITATION', label: 'Invitations to join a hackathon squad' },
  SQUAD_PROPOSAL: { type: 'TEAM_INVITATION', label: 'Squads proposed to you from the solo pool' },
  SQUAD_REMINDER: { type: 'HACKATHON_REMINDER', label: 'Reminders to find a team before a hackathon' },
  SQUAD_UPDATE: { type: 'SYSTEM', label: 'Changes to your squad (formed, someone left, a slot to refill)' },
  PEER_REVIEW: { type: 'SYSTEM', label: 'Asks to review your teammates after a hackathon' },
}

export const isNotificationKind = (value: unknown): value is NotificationKind => typeof value === 'string' && (NOTIFICATION_KINDS as readonly string[]).includes(value)

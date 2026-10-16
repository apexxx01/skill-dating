import type { Prisma } from '@prisma/client'
import { afterCommit, recordReward, type Db } from '@/lib/events'
import { isEnabled } from '@/lib/flags'
import { track } from '@/lib/infra/analytics'
import type { Metric } from '@/lib/metrics'
import type { QuestDefinition } from '@/lib/quest-definitions'
import { currentQuests, type QuestPeriod } from '@/lib/quests'
import { grant } from '@/lib/rewards'
import { emptyEnvelope, type EnvelopeDraft } from '@/lib/rewards-envelope'

// Quest progress. When the progress engine counts something for a user (src/lib/achievement-progress.ts),
// it calls advanceQuests() with the metric: if one of the user's three daily or three weekly quests
// asks for that metric, its count goes up by one, and reaching the target completes it. Completion
// pays the quest's XP through grant() on the same transaction, with the UserQuest as the source, so a
// quest can only ever pay once, and the rewards envelope of the request lists it in `questsCompleted`.
//
// A UserQuest row is created by the first thing that counts toward the quest, not when the quest is
// handed out, so a person who ignores their quests costs no rows.

export interface QuestProgress {
  current: number
  target: number
  completed: boolean
}

export function readProgress(value: Prisma.JsonValue | null | undefined, target: number): QuestProgress {
  const stored = (value ?? {}) as { current?: unknown; completed?: unknown }
  const current = typeof stored.current === 'number' && Number.isFinite(stored.current) ? Math.max(0, Math.floor(stored.current)) : 0
  return { current: Math.min(current, target), target, completed: stored.completed === true }
}

/** The quest rows the catalog needs to exist, created on first use so no seed step is needed. */
async function questRow(tx: Db, def: QuestDefinition): Promise<{ id: string }> {
  return tx.quest.upsert({
    where: { slug: def.slug },
    create: {
      slug: def.slug,
      name: def.name,
      description: def.description,
      type: def.type,
      criteria: { metric: def.metric, target: def.target },
      xpReward: def.xpReward,
    },
    update: {},
    select: { id: true },
  })
}

async function advanceInPeriod(tx: Db, userId: string, period: QuestPeriod, quests: QuestDefinition[], metric: Metric, now: Date): Promise<number> {
  let completed = 0
  for (const def of quests) {
    if (def.metric !== metric) continue
    const { id: questId } = await questRow(tx, def)

    await tx.userQuest.createMany({
      data: [
        {
          userId,
          questId,
          periodKey: period.key,
          periodStart: period.start,
          periodEnd: period.end,
          progress: { current: 0, target: def.target, completed: false },
        },
      ],
      skipDuplicates: true,
    })
    const row = await tx.userQuest.findUniqueOrThrow({
      where: { userId_questId_periodKey: { userId, questId, periodKey: period.key } },
      select: { id: true, progress: true, completedAt: true },
    })
    if (row.completedAt) continue

    const current = readProgress(row.progress, def.target).current + 1
    const done = current >= def.target
    await tx.userQuest.update({
      where: { id: row.id },
      data: { progress: { current: Math.min(current, def.target), target: def.target, completed: done }, ...(done ? { completedAt: now } : {}) },
    })
    if (!done) continue

    const result = await grant(tx, userId, 'QUEST_COMPLETED', {
      sourceType: 'QUEST',
      sourceId: row.id,
      amount: def.xpReward,
      description: `Completed the quest "${def.name}"`,
      now,
    })
    if (result.granted) {
      completed += 1
      await tx.notification.create({
        data: {
          userId,
          type: 'ACHIEVEMENT',
          title: 'Quest complete',
          message: def.name,
          metadata: { kind: 'QUEST_COMPLETED', slug: def.slug, xpReward: def.xpReward },
        },
      })
      // The XP part was recorded by grant(); this adds the completed quest to what the request reports.
      const envelope: EnvelopeDraft = { ...emptyEnvelope(result.envelope.totalXp), questsCompleted: [{ slug: def.slug, name: def.name }] }
      recordReward(tx, userId, envelope)
      afterCommit(tx, () => track(userId, 'quest_completed', { slug: def.slug, type: def.type, xpReward: def.xpReward }))
    }
  }
  return completed
}

export const QUESTS_FLAG = 'quests'

/** Whether quests are switched on for this user (the "quests" feature flag, on for everybody unless an operator changes it). */
export function questsEnabled(db: Db, userId: string): Promise<boolean> {
  return isEnabled(db as Parameters<typeof isEnabled>[0], QUESTS_FLAG, userId)
}

/**
 * Counts one thing the user did toward the quests they have right now. Returns how many quests this
 * completed. `timeZone` decides which day and week it is for them.
 */
export async function advanceQuests(tx: Db, userId: string, metric: Metric, now: Date, timeZone: string | null): Promise<number> {
  // The kill switch: with the "quests" flag off for this user nothing counts and nothing is paid.
  if (!(await questsEnabled(tx, userId))) return 0
  const { daily, weekly } = currentQuests(userId, now, timeZone)
  return (await advanceInPeriod(tx, userId, daily.period, daily.quests, metric, now)) + (await advanceInPeriod(tx, userId, weekly.period, weekly.quests, metric, now))
}

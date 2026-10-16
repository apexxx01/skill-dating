import type { PrismaClient } from '@prisma/client'
import type { QuestItem, QuestsResponse } from '@/types/api'
import type { QuestDefinition } from '@/lib/quest-definitions'
import { readProgress, questsEnabled } from '@/lib/quest-progress'
import { currentQuests, type QuestPeriod } from '@/lib/quests'
import { resolveTimeZone } from '@/lib/time'

// What GET /api/quests shows: the quests a person has right now (a pure function of user and period) with
// their progress, which comes from the UserQuest rows the engine has written so far. Nothing is written here.

export async function loadQuests(db: Pick<PrismaClient, 'userQuest' | 'featureFlag'>, userId: string, timeZone: string | null | undefined, now: Date = new Date()): Promise<QuestsResponse> {
  const { daily, weekly } = currentQuests(userId, now, timeZone)
  const group = (entry: { period: QuestPeriod; quests: QuestDefinition[] }, items: QuestItem[]) => ({
    periodKey: entry.period.key,
    startsAt: entry.period.start.toISOString(),
    resetsAt: entry.period.end.toISOString(),
    quests: items,
  })

  // Paused: show no quests rather than quests that cannot be completed.
  if (!(await questsEnabled(db as never, userId))) {
    return { enabled: false, timezone: resolveTimeZone(timeZone), daily: group(daily, []), weekly: group(weekly, []) }
  }

  const rows = await db.userQuest.findMany({
    where: { userId, periodKey: { in: [daily.period.key, weekly.period.key] }, quest: { slug: { in: [...daily.quests, ...weekly.quests].map((quest) => quest.slug) } } },
    select: { periodKey: true, progress: true, completedAt: true, quest: { select: { slug: true } } },
  })
  const byKey = new Map(rows.map((row) => [`${row.periodKey}|${row.quest.slug}`, row]))

  const item = (def: QuestDefinition, period: QuestPeriod): QuestItem => {
    const row = byKey.get(`${period.key}|${def.slug}`)
    const progress = readProgress(row?.progress, def.target)
    return {
      slug: def.slug,
      name: def.name,
      description: def.description,
      type: def.type,
      xpReward: def.xpReward,
      target: def.target,
      current: row?.completedAt ? def.target : progress.current,
      completed: Boolean(row?.completedAt),
      completedAt: row?.completedAt ? row.completedAt.toISOString() : null,
    }
  }
  return {
    enabled: true,
    timezone: resolveTimeZone(timeZone),
    daily: group(daily, daily.quests.map((def) => item(def, daily.period))),
    weekly: group(weekly, weekly.quests.map((def) => item(def, weekly.period))),
  }
}

import { getJobQueue } from '@/lib/infra/jobs'
import { log } from '@/lib/log'
import { invalidateUserViews } from '@/lib/xp-views'
import type { PlaceBefore } from './campus'

/** Tells the leaderboards a person's place changed (their campus), so their entries move: the job clears the boards they left. The nightly rebuild repairs a miss. */
export async function refreshBoards(userId: string, previous: PlaceBefore): Promise<void> {
  await invalidateUserViews(userId).catch((error) => log.warn('could not drop the cached views after a campus change', { error, userId }))
  try {
    await getJobQueue().enqueue('leaderboards/refresh-user', { userId, previous })
  } catch (error) {
    log.warn('could not queue the leaderboard refresh for a campus change', { error, userId })
  }
}

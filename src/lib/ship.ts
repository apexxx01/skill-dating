import type { Prisma } from '@prisma/client'
import { recordActivity } from '@/lib/activity'
import { emit } from '@/lib/events'
import { canAwardShipXp } from '@/lib/rewards-config'

// The ONE place a project is shipped. A project ships once: `shippedAt` is the gate (canAwardShipXp), so the XP, the reputation, the activity entry and the PROJECT_SHIPPED
// event happen exactly once however the status is set, by a PATCH of the project or by a SHIP post. Both call recordShip() inside their transaction; there is no second award path.

type Tx = Prisma.TransactionClient

/** The reputation event, the activity entry and the PROJECT_SHIPPED event (which pays the XP and counts the achievements). Call only when canAwardShipXp() said yes. */
export async function recordShip(tx: Tx, input: { userId: string; projectId: string; projectName: string }): Promise<void> {
  await tx.reputationEvent.create({
    data: { userId: input.userId, type: 'PROJECT_SHIPPED', amount: 100, sourceId: input.projectId, sourceType: 'PROJECT', description: 'Shipped project' },
  })
  await recordActivity(tx, input.userId, 'PROJECT_SHIPPED', `Shipped "${input.projectName}"`, { projectId: input.projectId })
  await emit(tx, 'PROJECT_SHIPPED', { userId: input.userId, projectId: input.projectId, projectName: input.projectName })
}

/**
 * Ships a project that is not yet shipped: sets the status and `shippedAt` and records it. Returns whether this call shipped it (false: it was already shipped once, or was shipped
 * by someone else a moment ago; nothing is awarded again).
 */
export async function shipProjectOnce(tx: Tx, input: { userId: string; projectId: string }): Promise<boolean> {
  const project = await tx.project.findUnique({ where: { id: input.projectId }, select: { name: true, status: true, shippedAt: true } })
  if (!project || !canAwardShipXp(project, 'SHIPPED')) return false
  // Only while shippedAt is still empty: two requests racing cannot both ship it.
  const changed = await tx.project.updateMany({ where: { id: input.projectId, shippedAt: null }, data: { status: 'SHIPPED', shippedAt: new Date() } })
  if (changed.count === 0) return false
  await recordShip(tx, { userId: input.userId, projectId: input.projectId, projectName: project.name })
  return true
}

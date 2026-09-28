// Single source of truth for XP amounts, so the same action always awards
// the same XP no matter which route triggers it, and so amounts can be
// tuned in one place instead of hunting through every API route.
export const XP_AWARDS = {
  PROJECT_CREATED: 50,
  PROJECT_SHIP: 200,
  HACKATHON_JOIN: 100,
  TEAM_FORMED: 50,
} as const

export type XpAwardType = keyof typeof XP_AWARDS

/**
 * Ship XP/reputation must be awarded exactly once per project, ever — not
 * once per SHIPPED transition. A project's `shippedAt` is only ever set the
 * first time it ships, so its presence is the one-time gate: cycling
 * SHIPPED -> BUILDING -> SHIPPED cannot re-trigger the award.
 */
export function canAwardShipXp(project: { status?: string | null; shippedAt: Date | null }, nextStatus: string | undefined): boolean {
  return nextStatus === 'SHIPPED' && !project.shippedAt
}

import type { PrismaClient } from '@prisma/client'
import type { CosmeticItem, CosmeticsResponse } from '@/types/api'
import { isSecretAchievement } from '@/lib/achievement-definitions'
import { COSMETIC_DEFINITIONS, requirementText, SLOT_OF } from '@/lib/cosmetic-definitions'
import { readEquipped } from '@/lib/cosmetics'

// What GET /api/users/me/cosmetics shows: the whole catalog, with what the caller owns and wears. A cosmetic
// that is earned by a secret achievement stays hidden (name, text and requirement) until it is owned, the way
// the achievement itself does.

export const SECRET_COSMETIC_NAME = 'Secret cosmetic'
export const SECRET_COSMETIC_DESCRIPTION = 'Keep building to find out what unlocks it.'

export async function loadCosmetics(db: Pick<PrismaClient, 'user' | 'userCosmetic'>, userId: string): Promise<CosmeticsResponse> {
  const [user, owned] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { equipped: true } }),
    db.userCosmetic.findMany({ where: { userId }, select: { unlockedAt: true, source: true, cosmetic: { select: { slug: true } } } }),
  ])
  const equipped = readEquipped(user?.equipped)
  const wearing = new Set(Object.values(equipped).filter((slug): slug is string => slug !== null))
  const mine = new Map(owned.map((row) => [row.cosmetic.slug, row]))

  const cosmetics = [...COSMETIC_DEFINITIONS]
    .sort((a, b) => a.order - b.order)
    .map((definition): CosmeticItem => {
      const row = mine.get(definition.slug)
      const secret = definition.unlockRule.type === 'ACHIEVEMENT' && isSecretAchievement(definition.unlockRule.slug)
      if (secret && !row) {
        return {
          slug: `secret-${definition.order}`,
          type: definition.type,
          name: SECRET_COSMETIC_NAME,
          description: SECRET_COSMETIC_DESCRIPTION,
          rarity: definition.rarity,
          slot: SLOT_OF[definition.type],
          owned: false,
          masked: true,
          equipped: false,
          unlockedAt: null,
          requirement: null,
          order: definition.order,
        }
      }
      return {
        slug: definition.slug,
        type: definition.type,
        name: definition.name,
        description: definition.description,
        rarity: definition.rarity,
        slot: SLOT_OF[definition.type],
        owned: Boolean(row),
        masked: false,
        equipped: wearing.has(definition.slug),
        unlockedAt: row ? row.unlockedAt.toISOString() : null,
        requirement: row ? null : requirementText(definition.unlockRule),
        order: definition.order,
      }
    })

  return { equipped, cosmetics, owned: cosmetics.filter((item) => item.owned).length, total: cosmetics.length }
}

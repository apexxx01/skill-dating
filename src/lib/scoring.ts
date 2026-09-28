// Canonical, pure scoring functions for the builder-matching core loop.
// Kept dependency-free (no Prisma import) so they're trivially unit-testable
// and reusable from any route/server-component without a DB round trip once
// the caller has already fetched skills.

export interface SkillRef {
  skillId: string
  level: number // 1-5
  category?: string | null
}

export interface CompatibilityResult {
  score: number // 0-100
  commonSkillIds: string[]
}

/**
 * Compatibility between two builders from their skill sets.
 *
 * Weighs shared skills (can collaborate directly) together with
 * complementary skills in different categories (fills gaps), so a pure
 * frontend dev and a pure backend dev score meaningfully higher than two
 * people with zero overlap and zero complementarity. Deterministic and
 * symmetric: compatibility(a, b) === compatibility(b, a).
 */
export function calculateSkillCompatibility(
  a: SkillRef[],
  b: SkillRef[]
): CompatibilityResult {
  if (a.length === 0 || b.length === 0) {
    return { score: 0, commonSkillIds: [] }
  }

  const aBySkill = new Map(a.map(s => [s.skillId, s]))
  const bBySkill = new Map(b.map(s => [s.skillId, s]))
  const allSkillIds = new Set([...aBySkill.keys(), ...bBySkill.keys()])

  const aCategories = new Set(a.map(s => s.category).filter(Boolean))
  const bCategories = new Set(b.map(s => s.category).filter(Boolean))

  let sharedScore = 0
  let maxSharedScore = 0
  const commonSkillIds: string[] = []

  for (const skillId of allSkillIds) {
    const aLevel = aBySkill.get(skillId)?.level ?? 0
    const bLevel = bBySkill.get(skillId)?.level ?? 0

    if (aLevel > 0 && bLevel > 0) {
      sharedScore += Math.min(aLevel, bLevel)
      commonSkillIds.push(skillId)
    }
    maxSharedScore += 5 // max possible level
  }

  const sharedRatio = maxSharedScore > 0 ? sharedScore / maxSharedScore : 0

  const categoryOverlap = [...aCategories].filter(c => bCategories.has(c)).length
  const categoryUnion = new Set([...aCategories, ...bCategories]).size
  // Complementarity: high when the two builders cover different categories.
  const complementarity = categoryUnion > 0 ? 1 - categoryOverlap / categoryUnion : 0

  const score = Math.round((sharedRatio * 0.6 + complementarity * 0.4) * 100)

  return {
    score: Math.min(99, Math.max(0, score)),
    commonSkillIds,
  }
}

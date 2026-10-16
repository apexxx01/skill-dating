// What a team is missing: its declared needs and its project's stack, set against what its members can do. Pure; the route loads the rows.
//
//  - A NEED is a name the team (or its project) asked for: `Team.lookingFor`, `Project.lookingFor`. If it is a skill of the catalog it is a skill
//    need, covered when a member has that skill; otherwise it is a ROLE ("Designer", "Growth"), covered when a member's builder role says so.
//  - The project's STACK is the technologies it is built with. An entry that is a catalog skill ("React", "Postgres") is a skill need too: somebody on
//    the team should know it. An entry that is not ("Vercel") cannot be checked against a member's skills and is only reported.

export interface CatalogSkill {
  slug: string
  name: string
}

export interface TeamMemberFacts {
  userId: string
  /** Slugs of the skills the member has. */
  skills: readonly string[]
  /** What the member calls their role ("Frontend developer"), if they say. */
  builderRole: string | null
}

export type NeedSource = 'TEAM_NEEDS' | 'PROJECT_NEEDS' | 'PROJECT_STACK'

export interface GapInput {
  teamNeeds: readonly string[]
  projectNeeds: readonly string[]
  projectStack: readonly string[]
  members: readonly TeamMemberFacts[]
  catalog: readonly CatalogSkill[]
}

export interface SkillNeed {
  name: string
  slug: string
  sources: NeedSource[]
}

export interface RoleNeed {
  name: string
  sources: NeedSource[]
}

export interface GapAnalysis {
  /** Skills the team wants or builds with that no member has. */
  missingSkills: SkillNeed[]
  /** Skills the team wants or builds with that at least one member has, with who. */
  coveredSkills: (SkillNeed & { memberIds: string[] })[]
  /** Roles the team asked for that no member's role matches. */
  missingRoles: RoleNeed[]
  coveredRoles: (RoleNeed & { memberIds: string[] })[]
  /** Technologies of the project that are not skills of the catalog, so cannot be checked against anyone. */
  unmatchedStack: string[]
}

export const normalizeName = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ')

const SOURCE_ORDER: NeedSource[] = ['TEAM_NEEDS', 'PROJECT_NEEDS', 'PROJECT_STACK']

export function analyzeGaps(input: GapInput): GapAnalysis {
  const bySlugOrName = new Map<string, CatalogSkill>()
  for (const skill of input.catalog) {
    bySlugOrName.set(normalizeName(skill.name), skill)
    bySlugOrName.set(normalizeName(skill.slug), skill)
  }

  const skillNeeds = new Map<string, SkillNeed>()
  const roleNeeds = new Map<string, RoleNeed>()
  const unmatched = new Set<string>()

  const add = (raw: string, source: NeedSource) => {
    const key = normalizeName(raw)
    if (!key) return
    const skill = bySlugOrName.get(key)
    if (skill) {
      const existing = skillNeeds.get(skill.slug)
      if (existing) {
        if (!existing.sources.includes(source)) existing.sources.push(source)
      } else {
        skillNeeds.set(skill.slug, { name: skill.name, slug: skill.slug, sources: [source] })
      }
    } else if (source === 'PROJECT_STACK') {
      unmatched.add(raw.trim())
    } else {
      const existing = roleNeeds.get(key)
      if (existing) {
        if (!existing.sources.includes(source)) existing.sources.push(source)
      } else {
        roleNeeds.set(key, { name: raw.trim(), sources: [source] })
      }
    }
  }
  for (const name of input.teamNeeds) add(name, 'TEAM_NEEDS')
  for (const name of input.projectNeeds) add(name, 'PROJECT_NEEDS')
  for (const name of input.projectStack) add(name, 'PROJECT_STACK')

  const sortSources = (sources: NeedSource[]) => [...sources].sort((a, b) => SOURCE_ORDER.indexOf(a) - SOURCE_ORDER.indexOf(b))

  const coveredSkills: GapAnalysis['coveredSkills'] = []
  const missingSkills: SkillNeed[] = []
  for (const need of skillNeeds.values()) {
    const memberIds = input.members.filter((member) => member.skills.includes(need.slug)).map((member) => member.userId)
    const sorted = { ...need, sources: sortSources(need.sources) }
    if (memberIds.length > 0) coveredSkills.push({ ...sorted, memberIds })
    else missingSkills.push(sorted)
  }

  const coveredRoles: GapAnalysis['coveredRoles'] = []
  const missingRoles: RoleNeed[] = []
  for (const [key, need] of roleNeeds) {
    // A role is covered when a member's own description of their role contains it, or is contained by it ("Designer" in "Product designer").
    const memberIds = input.members
      .filter((member) => {
        const role = member.builderRole ? normalizeName(member.builderRole) : ''
        return role !== '' && (role.includes(key) || key.includes(role))
      })
      .map((member) => member.userId)
    const sorted = { ...need, sources: sortSources(need.sources) }
    if (memberIds.length > 0) coveredRoles.push({ ...sorted, memberIds })
    else missingRoles.push(sorted)
  }

  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)
  return {
    missingSkills: missingSkills.sort(byName),
    coveredSkills: coveredSkills.sort(byName),
    missingRoles: missingRoles.sort(byName),
    coveredRoles: coveredRoles.sort(byName),
    unmatchedStack: [...unmatched].sort((a, b) => a.localeCompare(b)),
  }
}

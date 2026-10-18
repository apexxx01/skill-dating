import type { SquadRole } from '@prisma/client'

// The squad role catalogue: what an open slot asks for, what a member says they do, and the role template a squad of a given size is built against.
// Pure data and pure functions, shared by the slot routes, squad strength, the squad builder and the solo-pool optimiser. docs/SQUADS.md is the
// readable version.

export const SQUAD_ROLES = [
  'FRONTEND',
  'BACKEND',
  'FULLSTACK',
  'MOBILE',
  'ML_AI',
  'DATA',
  'DEVOPS',
  'DESIGN_UI_UX',
  'PRODUCT',
  'PITCH_BUSINESS',
  'HARDWARE',
  'OTHER',
] as const satisfies readonly SquadRole[]

export const ROLE_LABELS: Record<SquadRole, string> = {
  FRONTEND: 'Frontend developer',
  BACKEND: 'Backend developer',
  FULLSTACK: 'Full-stack developer',
  MOBILE: 'Mobile developer',
  ML_AI: 'ML / AI engineer',
  DATA: 'Data engineer',
  DEVOPS: 'DevOps engineer',
  DESIGN_UI_UX: 'Designer (UI/UX)',
  PRODUCT: 'Product lead',
  PITCH_BUSINESS: 'Pitch & business',
  HARDWARE: 'Hardware engineer',
  OTHER: 'Other',
}

/** How a gap names a role nobody covers: "No designer". */
export const ROLE_GAP_NAMES: Record<SquadRole, string> = {
  FRONTEND: 'frontend developer',
  BACKEND: 'backend developer',
  FULLSTACK: 'full-stack developer',
  MOBILE: 'mobile developer',
  ML_AI: 'ML/AI engineer',
  DATA: 'data engineer',
  DEVOPS: 'DevOps engineer',
  DESIGN_UI_UX: 'designer',
  PRODUCT: 'product lead',
  PITCH_BUSINESS: 'one to pitch',
  HARDWARE: 'hardware engineer',
  OTHER: 'specialist',
}

export const MAX_CUSTOM_LABEL = 40

/** A role as it is compared: the catalogue value, or OTHER with its label (two OTHER slots with different labels are different roles). */
export interface RoleRef {
  role: SquadRole
  customLabel?: string | null
}

/** A role the template asks for, with the skills it would like. */
export interface RoleNeed extends RoleRef {
  requiredSkills: string[]
}

export const normalizeLabel = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ')

/** A stable key for a role: "FRONTEND", or "OTHER:smart contract developer". */
export function roleKey(ref: RoleRef): string {
  return ref.role === 'OTHER' ? `OTHER:${normalizeLabel(ref.customLabel ?? '')}` : ref.role
}

export function roleLabel(ref: RoleRef): string {
  return ref.role === 'OTHER' && ref.customLabel?.trim() ? ref.customLabel.trim() : ROLE_LABELS[ref.role]
}

export function roleGapMessage(ref: RoleRef): string {
  if (ref.role === 'OTHER') return `No ${(ref.customLabel?.trim() || 'specialist').toLowerCase()}`
  return `No ${ROLE_GAP_NAMES[ref.role]}`
}

// --- Inferring a role from free text ---------------------------------------------------------------------------

export const SMART_CONTRACT_LABEL = 'Smart contract developer'

/**
 * Words and phrases that say a role, checked in this order (the more specific first: "react native" is mobile before "react" is frontend). A phrase
 * matches on word boundaries, so "ai" matches "AI" and "gen ai" but not "email".
 */
const ROLE_KEYWORDS: { ref: RoleRef; words: string[] }[] = [
  { ref: { role: 'OTHER', customLabel: SMART_CONTRACT_LABEL }, words: ['smart contract', 'smart contracts', 'solidity', 'web3', 'blockchain', 'ethereum', 'defi', 'solana', 'crypto', 'nft', 'evm', 'vyper'] },
  { ref: { role: 'FULLSTACK' }, words: ['fullstack', 'full-stack', 'full stack', 'mern', 'mean'] },
  { ref: { role: 'MOBILE' }, words: ['react native', 'mobile', 'ios', 'android', 'flutter', 'swift', 'swiftui', 'kotlin', 'expo'] },
  { ref: { role: 'ML_AI' }, words: ['machine learning', 'deep learning', 'computer vision', 'ml', 'ai', 'genai', 'gen ai', 'llm', 'llms', 'nlp', 'pytorch', 'tensorflow', 'openai', 'rag', 'agents'] },
  { ref: { role: 'DATA' }, words: ['data science', 'data engineering', 'data', 'analytics', 'pandas', 'spark', 'visualization', 'dbt', 'etl'] },
  { ref: { role: 'DEVOPS' }, words: ['devops', 'docker', 'kubernetes', 'k8s', 'aws', 'gcp', 'azure', 'terraform', 'ci/cd', 'cloud', 'infra', 'infrastructure', 'sre'] },
  { ref: { role: 'HARDWARE' }, words: ['hardware', 'iot', 'arduino', 'raspberry pi', 'embedded', 'robotics', 'electronics', 'firmware', 'fpga'] },
  { ref: { role: 'DESIGN_UI_UX' }, words: ['design', 'designer', 'ui', 'ux', 'ui/ux', 'figma', 'product design', 'graphic design'] },
  { ref: { role: 'PITCH_BUSINESS' }, words: ['pitch', 'pitching', 'go-to-market', 'gtm', 'business', 'marketing', 'sales', 'growth', 'bd', 'presentation', 'storytelling', 'finance'] },
  { ref: { role: 'PRODUCT' }, words: ['product', 'product manager', 'product management', 'pm', 'project management'] },
  { ref: { role: 'FRONTEND' }, words: ['frontend', 'front-end', 'front end', 'react', 'vue', 'angular', 'svelte', 'next.js', 'nextjs', 'css', 'html', 'tailwind', 'web'] },
  { ref: { role: 'BACKEND' }, words: ['backend', 'back-end', 'back end', 'node', 'node.js', 'nodejs', 'express', 'django', 'flask', 'fastapi', 'rails', 'go', 'golang', 'java', 'spring', 'postgres', 'postgresql', 'sql', 'api', 'apis', 'graphql', 'rust', 'python'] },
]

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
const KEYWORD_PATTERNS = ROLE_KEYWORDS.map(({ ref, words }) => ({ ref, pattern: new RegExp(`(^|[^a-z0-9+#])(${words.map(escape).join('|')})(?=$|[^a-z0-9+#])`) }))

/** The role a skill, a technology or a self-description most likely means, or null when it says none. */
export function inferRole(text: string | null | undefined): RoleRef | null {
  const value = (text ?? '').toLowerCase()
  if (!value.trim()) return null
  for (const { ref, pattern } of KEYWORD_PATTERNS) if (pattern.test(value)) return { ...ref }
  return null
}

/** Every distinct role a list of texts implies, in the order first implied. */
export function inferRoles(texts: readonly (string | null | undefined)[]): RoleRef[] {
  const seen = new Map<string, RoleRef>()
  for (const text of texts) {
    const ref = inferRole(text)
    if (ref && !seen.has(roleKey(ref))) seen.set(roleKey(ref), ref)
  }
  return [...seen.values()]
}

// --- lookingFor, the old free-text field -----------------------------------------------------------------------

export interface SlotLike extends RoleRef {
  status: 'OPEN' | 'FILLED'
  requiredSkills: readonly string[]
}

/**
 * Team.lookingFor as old clients knew it, derived from the open slots: their required skills, then the label of any open slot that asks for none,
 * each once (first spelling wins, compared without case).
 */
export function derivedLookingFor(slots: readonly SlotLike[]): string[] {
  const out = new Map<string, string>()
  for (const slot of slots) {
    if (slot.status !== 'OPEN') continue
    const entries = slot.requiredSkills.length > 0 ? slot.requiredSkills : [roleLabel(slot)]
    for (const entry of entries) {
      const trimmed = entry.trim()
      if (trimmed && !out.has(normalizeLabel(trimmed))) out.set(normalizeLabel(trimmed), trimmed)
    }
  }
  return [...out.values()].slice(0, 20)
}

/** An old client's lookingFor turned into slots: one per entry, the role inferred from it (OTHER, labelled with it, when none is), asking for it as a skill. */
export function slotsFromLookingFor(entries: readonly string[]): RoleNeed[] {
  const seen = new Set<string>()
  const out: RoleNeed[] = []
  for (const raw of entries) {
    const entry = raw.trim()
    if (!entry || seen.has(normalizeLabel(entry))) continue
    seen.add(normalizeLabel(entry))
    const ref = inferRole(entry)
    out.push(ref && ref.role !== 'OTHER' ? { role: ref.role, requiredSkills: [entry] } : { role: 'OTHER', customLabel: (ref?.customLabel ?? entry).slice(0, MAX_CUSTOM_LABEL), requiredSkills: [entry] })
  }
  return out
}

// --- Role templates --------------------------------------------------------------------------------------------

/** The balanced squad when a hackathon says nothing in particular, in the order roles are added as the squad grows. */
export const DEFAULT_TEMPLATE: readonly SquadRole[] = ['FRONTEND', 'BACKEND', 'DESIGN_UI_UX', 'PITCH_BUSINESS', 'FULLSTACK', 'PRODUCT', 'DEVOPS', 'DATA', 'ML_AI', 'MOBILE']

/** The roles that are "specialised": a hackathon or track that names them makes them a need ahead of the balanced template. */
const SPECIALISED: readonly string[] = ['OTHER', 'ML_AI', 'MOBILE', 'HARDWARE', 'DATA', 'DEVOPS']

export const DEFAULT_SQUAD_SIZE = 4

export interface TemplateInput {
  /** The hackathon's technologies. */
  technologies: readonly string[]
  /** The tracks the squad goes for (or the hackathon's, when it chose none): their names and descriptions. */
  tracks: readonly { name: string; description?: string | null }[]
  size: number
}

/**
 * The roles a squad of `size` should have: the specialised roles the tracks and then the technologies name (a Web3 track wants a smart contract
 * developer, an AI track an ML engineer), at most size - 1 of them so there is always room for a builder of the product, then the balanced template.
 * Each role asks for the hackathon technologies that imply it. Deterministic.
 */
export function templateFor(input: TemplateInput): RoleNeed[] {
  const size = Math.max(1, Math.min(10, Math.floor(input.size)))
  const signals = [...input.tracks.flatMap((track) => [track.name, track.description ?? '']), ...input.technologies]
  const specialised = inferRoles(signals).filter((ref) => SPECIALISED.includes(ref.role)).slice(0, Math.max(0, size - 1))

  const needs: RoleNeed[] = specialised.map((ref) => ({ ...ref, requiredSkills: [] }))
  const have = new Set(needs.map(roleKey))
  for (const role of DEFAULT_TEMPLATE) {
    if (needs.length >= size) break
    if (have.has(role)) continue
    // A squad with a mobile developer does not also need a separate frontend developer until it is large.
    if (role === 'FRONTEND' && have.has('MOBILE') && size <= 4) continue
    needs.push({ role, requiredSkills: [] })
    have.add(role)
  }

  // Each technology goes to the role it implies, when the template has that role.
  for (const technology of input.technologies) {
    const ref = inferRole(technology)
    const need = ref ? needs.find((candidate) => roleKey(candidate) === roleKey(ref)) : undefined
    if (need && !need.requiredSkills.some((skill) => normalizeLabel(skill) === normalizeLabel(technology))) need.requiredSkills.push(technology.trim())
  }
  return needs
}

/** The squad size to propose: the default (4) within the hackathon's bounds, or what was asked for within them. */
export function squadSizeFor(bounds: { minTeamSize: number; maxTeamSize: number }, asked?: number | null): number {
  const min = Math.max(1, bounds.minTeamSize)
  const max = Math.max(min, bounds.maxTeamSize)
  return Math.min(max, Math.max(min, asked ?? DEFAULT_SQUAD_SIZE))
}

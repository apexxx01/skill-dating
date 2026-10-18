import { describe, it, expect } from 'vitest'
import {
  derivedLookingFor,
  inferRole,
  inferRoles,
  roleGapMessage,
  roleKey,
  roleLabel,
  slotsFromLookingFor,
  SMART_CONTRACT_LABEL,
  SQUAD_ROLES,
  squadSizeFor,
  templateFor,
  type SlotLike,
} from './roles'

describe('the role catalogue', () => {
  it('is the fixed list, OTHER last', () => {
    expect(SQUAD_ROLES).toEqual(['FRONTEND', 'BACKEND', 'FULLSTACK', 'MOBILE', 'ML_AI', 'DATA', 'DEVOPS', 'DESIGN_UI_UX', 'PRODUCT', 'PITCH_BUSINESS', 'HARDWARE', 'OTHER'])
  })

  it('keys and labels OTHER by its custom label, everything else by the role', () => {
    expect(roleKey({ role: 'BACKEND', customLabel: 'ignored' })).toBe('BACKEND')
    expect(roleKey({ role: 'OTHER', customLabel: '  Smart   Contract Developer ' })).toBe('OTHER:smart contract developer')
    expect(roleLabel({ role: 'OTHER', customLabel: 'Game designer' })).toBe('Game designer')
    expect(roleLabel({ role: 'OTHER' })).toBe('Other')
    expect(roleLabel({ role: 'DESIGN_UI_UX' })).toBe('Designer (UI/UX)')
  })

  it('names a missing role the way a gap says it', () => {
    expect(roleGapMessage({ role: 'DESIGN_UI_UX' })).toBe('No designer')
    expect(roleGapMessage({ role: 'PITCH_BUSINESS' })).toBe('No one to pitch')
    expect(roleGapMessage({ role: 'OTHER', customLabel: 'Smart contract developer' })).toBe('No smart contract developer')
  })
})

describe('inferRole', () => {
  it.each([
    ['React', 'FRONTEND'],
    ['Next.js', 'FRONTEND'],
    ['Node.js', 'BACKEND'],
    ['PostgreSQL', 'BACKEND'],
    ['React Native', 'MOBILE'],
    ['Flutter', 'MOBILE'],
    ['Machine Learning', 'ML_AI'],
    ['GenAI agents', 'ML_AI'],
    ['AI', 'ML_AI'],
    ['Figma', 'DESIGN_UI_UX'],
    ['Product design', 'DESIGN_UI_UX'],
    ['Full-stack developer', 'FULLSTACK'],
    ['Kubernetes', 'DEVOPS'],
    ['Arduino', 'HARDWARE'],
    ['Data science', 'DATA'],
    ['Pitching', 'PITCH_BUSINESS'],
    ['Go-to-market', 'PITCH_BUSINESS'],
    ['Product manager', 'PRODUCT'],
  ])('%s is %s', (text, role) => {
    expect(inferRole(text)?.role).toBe(role)
  })

  it('reads Web3 words as a smart contract developer (OTHER with a label)', () => {
    for (const text of ['Solidity', 'web3', 'Ethereum dApps', 'Smart contracts']) expect(inferRole(text)).toEqual({ role: 'OTHER', customLabel: SMART_CONTRACT_LABEL })
  })

  it('matches on word boundaries: "email" is not AI, "web3" is not "web"', () => {
    expect(inferRole('email templates')).toBeNull()
    expect(inferRole('web3')?.role).toBe('OTHER')
  })

  it('says nothing for empty or unknown text', () => {
    expect(inferRole('')).toBeNull()
    expect(inferRole(null)).toBeNull()
    expect(inferRole('Underwater basket weaving')).toBeNull()
  })

  it('lists each implied role once, in order', () => {
    expect(inferRoles(['React', 'Vue', 'Figma', null, 'Node']).map(roleKey)).toEqual(['FRONTEND', 'DESIGN_UI_UX', 'BACKEND'])
  })
})

describe('lookingFor, derived from slots', () => {
  const slot = (over: Partial<SlotLike>): SlotLike => ({ role: 'FRONTEND', status: 'OPEN', requiredSkills: [], ...over })

  it('lists the required skills of open slots, then the label of an open slot that asks for none, each once', () => {
    const slots = [
      slot({ requiredSkills: ['React', 'TypeScript'] }),
      slot({ role: 'BACKEND', requiredSkills: ['react', 'Go'] }),
      slot({ role: 'DESIGN_UI_UX' }),
      slot({ role: 'ML_AI', status: 'FILLED', requiredSkills: ['PyTorch'] }),
    ]
    expect(derivedLookingFor(slots)).toEqual(['React', 'TypeScript', 'Go', 'Designer (UI/UX)'])
  })

  it('is empty when nothing is open', () => {
    expect(derivedLookingFor([slot({ status: 'FILLED', requiredSkills: ['React'] })])).toEqual([])
  })

  it('turns an old lookingFor into slots that derive back to the same list', () => {
    const entries = ['React', 'Solidity', 'Underwater basket weaving', 'react', ' ']
    const slots = slotsFromLookingFor(entries)
    expect(slots).toEqual([
      { role: 'FRONTEND', requiredSkills: ['React'] },
      { role: 'OTHER', customLabel: SMART_CONTRACT_LABEL, requiredSkills: ['Solidity'] },
      { role: 'OTHER', customLabel: 'Underwater basket weaving', requiredSkills: ['Underwater basket weaving'] },
    ])
    expect(derivedLookingFor(slots.map((s) => ({ ...s, status: 'OPEN' as const })))).toEqual(['React', 'Solidity', 'Underwater basket weaving'])
  })
})

describe('templateFor', () => {
  it('is the balanced default for a hackathon that says nothing', () => {
    expect(templateFor({ technologies: [], tracks: [], size: 4 }).map(roleKey)).toEqual(['FRONTEND', 'BACKEND', 'DESIGN_UI_UX', 'PITCH_BUSINESS'])
    expect(templateFor({ technologies: [], tracks: [], size: 2 }).map(roleKey)).toEqual(['FRONTEND', 'BACKEND'])
  })

  it('puts the roles a track names first: an AI track wants ML, a Web3 track a smart contract developer', () => {
    expect(templateFor({ technologies: [], tracks: [{ name: 'Best use of AI' }], size: 4 }).map(roleKey)).toEqual(['ML_AI', 'FRONTEND', 'BACKEND', 'DESIGN_UI_UX'])
    const web3 = templateFor({ technologies: [], tracks: [{ name: 'DeFi', description: 'Build on Ethereum' }], size: 4 })
    expect(web3[0]).toEqual({ role: 'OTHER', customLabel: SMART_CONTRACT_LABEL, requiredSkills: [] })
  })

  it('leaves room for at least one generalist role however many specialised roles are named', () => {
    const needs = templateFor({ technologies: ['Solidity', 'PyTorch', 'Flutter', 'Arduino'], tracks: [], size: 3 })
    expect(needs).toHaveLength(3)
    expect(needs.map((n) => n.role)).toEqual(['OTHER', 'ML_AI', 'FRONTEND'])
  })

  it('does not ask for frontend in a small squad that already has mobile', () => {
    expect(templateFor({ technologies: ['Flutter'], tracks: [], size: 4 }).map(roleKey)).toEqual(['MOBILE', 'BACKEND', 'DESIGN_UI_UX', 'PITCH_BUSINESS'])
  })

  it('gives each role the technologies that imply it', () => {
    const needs = templateFor({ technologies: ['React', 'Node.js', 'Tailwind', 'react'], tracks: [], size: 3 })
    expect(needs).toEqual([
      { role: 'FRONTEND', requiredSkills: ['React', 'Tailwind'] },
      { role: 'BACKEND', requiredSkills: ['Node.js'] },
      { role: 'DESIGN_UI_UX', requiredSkills: [] },
    ])
  })

  it('is deterministic', () => {
    const input = { technologies: ['Rust', 'Solidity', 'Figma'], tracks: [{ name: 'AI' }], size: 5 }
    expect(templateFor(input)).toEqual(templateFor(input))
  })
})

describe('squadSizeFor', () => {
  it('defaults to 4 within the hackathon bounds', () => {
    expect(squadSizeFor({ minTeamSize: 1, maxTeamSize: 5 })).toBe(4)
    expect(squadSizeFor({ minTeamSize: 1, maxTeamSize: 3 })).toBe(3)
    expect(squadSizeFor({ minTeamSize: 5, maxTeamSize: 6 })).toBe(5)
  })

  it('takes what was asked for, clamped to the bounds', () => {
    expect(squadSizeFor({ minTeamSize: 2, maxTeamSize: 5 }, 2)).toBe(2)
    expect(squadSizeFor({ minTeamSize: 2, maxTeamSize: 5 }, 9)).toBe(5)
    expect(squadSizeFor({ minTeamSize: 2, maxTeamSize: 5 }, 1)).toBe(2)
  })
})

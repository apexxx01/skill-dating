import { describe, it, expect, vi } from 'vitest'
import { checkOwnership, checkMembership, authorize } from './permissions'

// A minimal Prisma stand-in: only the model methods these functions touch.
function mockPrisma(overrides: Record<string, any> = {}) {
  return {
    project: { findUnique: vi.fn() },
    team: { findUnique: vi.fn() },
    message: { findUnique: vi.fn() },
    connection: { findUnique: vi.fn() },
    projectMember: { findUnique: vi.fn() },
    teamMember: { findUnique: vi.fn() },
    conversationMember: { findUnique: vi.fn() },
    hackathonParticipant: { findUnique: vi.fn() },
    ...overrides,
  } as any
}

describe('checkOwnership', () => {
  it('returns true when the caller owns the project', async () => {
    const prisma = mockPrisma({ project: { findUnique: vi.fn().mockResolvedValue({ ownerId: 'u1' }) } })
    expect(await checkOwnership(prisma, 'u1', 'project', 'p1')).toBe(true)
  })

  it('returns false when a different user owns the project (IDOR guard)', async () => {
    const prisma = mockPrisma({ project: { findUnique: vi.fn().mockResolvedValue({ ownerId: 'u1' }) } })
    expect(await checkOwnership(prisma, 'attacker', 'project', 'p1')).toBe(false)
  })

  it('returns false for a nonexistent resource rather than throwing', async () => {
    const prisma = mockPrisma({ team: { findUnique: vi.fn().mockResolvedValue(null) } })
    expect(await checkOwnership(prisma, 'u1', 'team', 'missing')).toBe(false)
  })

  it('treats either side of a connection as ownership', async () => {
    const prisma = mockPrisma({
      connection: { findUnique: vi.fn().mockResolvedValue({ senderId: 'u1', receiverId: 'u2' }) },
    })
    expect(await checkOwnership(prisma, 'u1', 'connection', 'c1')).toBe(true)
    expect(await checkOwnership(prisma, 'u2', 'connection', 'c1')).toBe(true)
    expect(await checkOwnership(prisma, 'u3', 'connection', 'c1')).toBe(false)
  })

  it('returns false for an unknown resource type instead of throwing', async () => {
    const prisma = mockPrisma()
    expect(await checkOwnership(prisma, 'u1', 'not-a-real-type', 'x')).toBe(false)
  })
})

describe('checkMembership', () => {
  it('returns true only when a membership row exists', async () => {
    const prisma = mockPrisma({ teamMember: { findUnique: vi.fn().mockResolvedValue({ userId: 'u1', teamId: 't1' }) } })
    expect(await checkMembership(prisma, 'u1', 'team', 't1')).toBe(true)
  })

  it('returns false when no membership row exists', async () => {
    const prisma = mockPrisma({ teamMember: { findUnique: vi.fn().mockResolvedValue(null) } })
    expect(await checkMembership(prisma, 'outsider', 'team', 't1')).toBe(false)
  })
})

describe('authorize', () => {
  it('lets ADMIN through unconditionally, even against an unrelated resource', async () => {
    const prisma = mockPrisma({ project: { findUnique: vi.fn().mockResolvedValue({ ownerId: 'someone-else' }) } })
    expect(await authorize(prisma, 'admin1', 'ADMIN', 'delete', 'project', 'p1')).toBe(true)
  })

  it('lets MODERATOR write/read but not delete', async () => {
    const prisma = mockPrisma({ project: { findUnique: vi.fn().mockResolvedValue({ ownerId: 'someone-else' }) } })
    expect(await authorize(prisma, 'mod1', 'MODERATOR', 'write', 'project', 'p1')).toBe(true)
    expect(await authorize(prisma, 'mod1', 'MODERATOR', 'delete', 'project', 'p1')).toBe(false)
  })

  it('denies a non-member, non-owner USER outright (IDOR guard)', async () => {
    const prisma = mockPrisma({
      project: { findUnique: vi.fn().mockResolvedValue({ ownerId: 'owner' }) },
      projectMember: { findUnique: vi.fn().mockResolvedValue(null) },
    })
    expect(await authorize(prisma, 'attacker', 'USER', 'read', 'project', 'p1')).toBe(false)
  })

  it('lets a member read and write but not delete', async () => {
    const prisma = mockPrisma({
      project: { findUnique: vi.fn().mockResolvedValue({ ownerId: 'owner' }) },
      projectMember: { findUnique: vi.fn().mockResolvedValue({ userId: 'member1' }) },
    })
    expect(await authorize(prisma, 'member1', 'USER', 'read', 'project', 'p1')).toBe(true)
    expect(await authorize(prisma, 'member1', 'USER', 'write', 'project', 'p1')).toBe(true)
    expect(await authorize(prisma, 'member1', 'USER', 'delete', 'project', 'p1')).toBe(false)
  })

  it('lets the owner delete, unlike a plain member', async () => {
    const prisma = mockPrisma({ project: { findUnique: vi.fn().mockResolvedValue({ ownerId: 'owner1' }) } })
    expect(await authorize(prisma, 'owner1', 'USER', 'delete', 'project', 'p1')).toBe(true)
  })
})

import { describe, it, expect, vi } from 'vitest'
import { heatmapRange, loadHeatmap, MAX_HEATMAP_DAYS } from './heatmap'

describe('heatmapRange', () => {
  const now = new Date('2026-03-10T20:00:00Z')

  it('is the given number of local days ending today, inclusive', () => {
    expect(heatmapRange(1, 'UTC', now)).toMatchObject({ from: '2026-03-10', to: '2026-03-10' })
    expect(heatmapRange(7, 'UTC', now)).toMatchObject({ from: '2026-03-04', to: '2026-03-10' })
    expect(heatmapRange(MAX_HEATMAP_DAYS, 'UTC', now)).toMatchObject({ from: '2025-03-11', to: '2026-03-10' })
  })

  it('starts at the first instant of the first local day', () => {
    expect(heatmapRange(1, 'UTC', now).since.toISOString()).toBe('2026-03-10T00:00:00.000Z')
    expect(heatmapRange(3, 'Asia/Kolkata', now)).toMatchObject({ from: '2026-03-09', to: '2026-03-11' })
    expect(heatmapRange(3, 'Asia/Kolkata', now).since.toISOString()).toBe('2026-03-08T18:30:00.000Z')
  })

  it('uses the owner zone, so the same instant can be a different day', () => {
    expect(heatmapRange(1, 'America/Los_Angeles', now).to).toBe('2026-03-10')
    expect(heatmapRange(1, 'Pacific/Kiritimati', now).to).toBe('2026-03-11')
  })

  it('counts calendar days across a daylight saving change', () => {
    const range = heatmapRange(3, 'America/New_York', new Date('2026-03-09T16:00:00Z'))
    expect(range).toMatchObject({ from: '2026-03-07', to: '2026-03-09' })
    expect(range.since.toISOString()).toBe('2026-03-07T05:00:00.000Z') // EST, before the clocks moved
  })

  it('falls back to UTC for a missing or invalid zone and says so', () => {
    expect(heatmapRange(1, null, now).timezone).toBe('UTC')
    expect(heatmapRange(1, 'Not/AZone', now).timezone).toBe('UTC')
    expect(heatmapRange(1, 'Asia/Kolkata', now).timezone).toBe('Asia/Kolkata')
  })
})

describe('loadHeatmap', () => {
  it('turns the grouped rows into numbers, in the order the database gave them', async () => {
    const queryRaw = vi.fn().mockResolvedValue([
      { date: '2026-03-08', xp: BigInt(75), actions: BigInt(1) },
      { date: '2026-03-10', xp: 300, actions: 2 },
    ])
    const range = heatmapRange(7, 'UTC', new Date('2026-03-10T12:00:00Z'))
    const items = await loadHeatmap({ $queryRaw: queryRaw } as never, 'u1', range)
    expect(items).toEqual([
      { date: '2026-03-08', xp: 75, actions: 1 },
      { date: '2026-03-10', xp: 300, actions: 2 },
    ])
    expect(queryRaw).toHaveBeenCalledTimes(1)
  })

  it('returns nothing for a person with no XP', async () => {
    expect(await loadHeatmap({ $queryRaw: vi.fn().mockResolvedValue([]) } as never, 'u1', heatmapRange(30, 'UTC'))).toEqual([])
  })
})

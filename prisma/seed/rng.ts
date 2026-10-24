// A seeded random number generator, so the same seed builds the same world every time. mulberry32: small, fast, and good enough for picking names and days.

export interface Rng {
  /** A float in [0, 1). */
  next(): number
  /** An integer in [min, max], both included. */
  int(min: number, max: number): number
  /** true with probability p. */
  chance(p: number): boolean
  pick<T>(items: readonly T[]): T
  /** One of the items, the heavier ones more often. */
  weighted<T>(items: readonly (readonly [T, number])[]): T
  /** `count` distinct items, in a random order. */
  sample<T>(items: readonly T[], count: number): T[]
  shuffle<T>(items: readonly T[]): T[]
  /** A child generator for a named part of the world: adding a feature that draws numbers does not shift the numbers of the other parts. */
  fork(label: string): Rng
}

/** FNV-1a over a string, as a 32-bit number. */
export function hashString(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const rng: Rng = {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: (items) => items[Math.floor(next() * items.length)],
    weighted: (items) => {
      const total = items.reduce((sum, [, weight]) => sum + weight, 0)
      let roll = next() * total
      for (const [item, weight] of items) {
        roll -= weight
        if (roll < 0) return item
      }
      return items[items.length - 1][0]
    },
    shuffle: (items) => {
      const copy = [...items]
      for (let index = copy.length - 1; index > 0; index--) {
        const other = Math.floor(next() * (index + 1))
        ;[copy[index], copy[other]] = [copy[other], copy[index]]
      }
      return copy
    },
    sample: (items, count) => rng.shuffle(items).slice(0, count),
    fork: (label) => createRng((hashString(label) ^ Math.imul(seed >>> 0, 0x9e3779b1)) >>> 0),
  }
  return rng
}

/** A generator for a seed given as text or number; its `fork` children depend only on the seed and their label. */
export const rngFor = (seed: string | number): Rng => createRng(typeof seed === 'number' ? seed >>> 0 : hashString(seed))

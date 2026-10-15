import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

// "The rewards engine is the only way XP is ever awarded" is a rule about the whole
// code base, so it is checked against the whole code base: nothing under src/ except
// src/lib/rewards.ts may write an XPEvent or change User.xp. (The demo seed in
// prisma/ writes sample XP directly on purpose; it is not part of the application.)

const SRC = path.resolve(__dirname, '..')
const ALLOWED = new Set([path.join(SRC, 'lib', 'rewards.ts')])

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(full)
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [full] : []
  })
}

const WRITES = [
  /xPEvent\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/,
  /xp\s*:\s*\{\s*(increment|decrement|set|multiply)\b/,
  /SET\s+"xp"/i,
  /INSERT\s+INTO\s+"XPEvent"/i,
]

describe('XP writers', () => {
  const files = walk(SRC)

  it('finds the source files to scan', () => {
    expect(files.length).toBeGreaterThan(100)
    expect(files).toContain(path.join(SRC, 'lib', 'rewards.ts'))
  })

  it('has no code outside the rewards engine that writes an XPEvent or changes User.xp', () => {
    const offenders = files
      .filter((file) => !ALLOWED.has(file))
      .filter((file) => {
        const text = fs.readFileSync(file, 'utf-8')
        return WRITES.some((pattern) => pattern.test(text))
      })
      .map((file) => path.relative(SRC, file))
    expect(offenders).toEqual([])
  })

  it('does find the writes inside the engine, so the scan is not blind', () => {
    const text = fs.readFileSync(path.join(SRC, 'lib', 'rewards.ts'), 'utf-8')
    expect(WRITES.filter((pattern) => pattern.test(text)).length).toBeGreaterThanOrEqual(2)
  })

  it('catches each kind of write it is meant to catch', () => {
    const samples = [
      'await tx.xPEvent.create({ data })',
      'prisma.xPEvent.updateMany({})',
      'data: { xp: { increment: 5 } }',
      'await tx.$executeRaw`UPDATE "User" SET "xp" = 1`',
      'INSERT INTO "XPEvent" (a) VALUES (1)',
    ]
    for (const sample of samples) expect(WRITES.some((pattern) => pattern.test(sample)), sample).toBe(true)
    for (const fine of ['prisma.xPEvent.aggregate({})', 'prisma.xPEvent.findMany({})', 'select: { xp: true }', 'orderBy: { xp: "desc" }']) {
      expect(WRITES.some((pattern) => pattern.test(fine)), fine).toBe(false)
    }
  })
})

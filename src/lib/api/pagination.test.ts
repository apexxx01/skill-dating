import { describe, it, expect } from 'vitest'
import {
  cursorParam,
  decodeKeysetCursor,
  decodeOffsetCursor,
  encodeKeysetCursor,
  encodeOffsetCursor,
  keysetOrderBy,
  keysetPage,
  keysetWhere,
  offsetCursorAfterPage,
  offsetPage,
} from './pagination'

describe('keyset cursors', () => {
  it('round-trips a date, a number and a string sort value with the id', () => {
    const date = new Date('2026-03-04T05:06:07.890Z')
    expect(decodeKeysetCursor(encodeKeysetCursor(date, 'id1'))).toEqual({ sort: date, id: 'id1' })
    expect(decodeKeysetCursor(encodeKeysetCursor(42.5, 'id2'))).toEqual({ sort: 42.5, id: 'id2' })
    expect(decodeKeysetCursor(encodeKeysetCursor('alpha', 'id3'))).toEqual({ sort: 'alpha', id: 'id3' })
    expect(decodeKeysetCursor(encodeKeysetCursor(-3, 'id4'))).toEqual({ sort: -3, id: 'id4' })
  })

  it('is URL-safe and opaque', () => {
    const cursor = encodeKeysetCursor(new Date(), 'abc')
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(cursor).not.toContain('abc')
  })

  it('rejects text that is not a cursor, without throwing', () => {
    for (const bad of ['', 'not a cursor', '!!!', 'e30', Buffer.from('{"k":"keyset"}').toString('base64url'), Buffer.from('[]').toString('base64url'), Buffer.from('null').toString('base64url')]) {
      expect(decodeKeysetCursor(bad)).toBeNull()
    }
  })

  it('rejects well-formed JSON with the wrong shape', () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    expect(decodeKeysetCursor(encode({ k: 'keyset', s: { t: 'd', v: 'x' }, id: 'a' }))).toBeNull()
    expect(decodeKeysetCursor(encode({ k: 'keyset', s: { t: 'n', v: null }, id: 'a' }))).toBeNull()
    expect(decodeKeysetCursor(encode({ k: 'keyset', s: { t: 'q', v: 1 }, id: 'a' }))).toBeNull()
    expect(decodeKeysetCursor(encode({ k: 'keyset', s: { t: 's', v: 'x' }, id: '' }))).toBeNull()
    expect(decodeKeysetCursor(encode({ k: 'keyset', s: { t: 's', v: 'x' }, id: 'a'.repeat(129) }))).toBeNull()
    expect(decodeKeysetCursor(encode({ k: 'keyset', s: { t: 's', v: 'x'.repeat(201) }, id: 'a' }))).toBeNull()
  })

  it('is not accepted as an offset cursor, nor the reverse', () => {
    expect(decodeOffsetCursor(encodeKeysetCursor('a', 'b'))).toBeNull()
    expect(decodeKeysetCursor(encodeOffsetCursor(10))).toBeNull()
  })
})

describe('keysetWhere and keysetOrderBy', () => {
  const position = { sort: new Date('2026-01-01T00:00:00Z'), id: 'row9' }

  it('seeks below the last row when descending, with the id breaking ties', () => {
    expect(keysetWhere('createdAt', 'desc', position)).toEqual({
      OR: [{ createdAt: { lt: position.sort } }, { createdAt: position.sort, id: { lt: 'row9' } }],
    })
    expect(keysetOrderBy('createdAt', 'desc')).toEqual([{ createdAt: 'desc' }, { id: 'desc' }])
  })

  it('seeks above the last row when ascending', () => {
    expect(keysetWhere('name', 'asc', { sort: 'm', id: 'x' })).toEqual({ OR: [{ name: { gt: 'm' } }, { name: 'm', id: { gt: 'x' } }] })
    expect(keysetOrderBy('name', 'asc')).toEqual([{ name: 'asc' }, { id: 'asc' }])
  })

  it('can break ties on a column other than id', () => {
    expect(keysetWhere('createdAt', 'desc', position, 'userId')).toEqual({
      OR: [{ createdAt: { lt: position.sort } }, { createdAt: position.sort, userId: { lt: 'row9' } }],
    })
  })
})

// A tiny in-memory "table" that answers the same where/orderBy the helpers produce,
// to prove that paging through it visits every row exactly once.
type Row = { id: string; at: number }
function seek(rows: Row[], direction: 'asc' | 'desc', after: { sort: number; id: string } | null, take: number): Row[] {
  const sorted = [...rows].sort((a, b) => (a.at === b.at ? a.id.localeCompare(b.id) : a.at - b.at))
  if (direction === 'desc') sorted.reverse()
  const filtered = after
    ? sorted.filter((row) => {
        const past = direction === 'desc' ? row.at < after.sort || (row.at === after.sort && row.id < after.id) : row.at > after.sort || (row.at === after.sort && row.id > after.id)
        return past
      })
    : sorted
  return filtered.slice(0, take)
}

describe('keysetPage', () => {
  const table: Row[] = Array.from({ length: 23 }, (_, index) => ({ id: `r${String(index).padStart(2, '0')}`, at: Math.floor(index / 4) }))

  it.each(['asc', 'desc'] as const)('visits every row once, in order, including rows that tie (%s)', (direction) => {
    const seen: string[] = []
    let after: { sort: number; id: string } | null = null
    for (let guard = 0; guard < 20; guard++) {
      const rows = seek(table, direction, after, 6)
      const page = keysetPage(rows, 5, (row) => ({ sort: row.at, id: row.id }))
      seen.push(...page.items.map((row) => row.id))
      if (!page.nextCursor) break
      const decoded = decodeKeysetCursor(page.nextCursor)!
      after = { sort: decoded.sort as number, id: decoded.id }
    }
    expect(seen).toHaveLength(23)
    expect(new Set(seen).size).toBe(23)
    expect(seen).toEqual(seek(table, direction, null, 100).map((row) => row.id))
  })

  it('has no cursor on the last page, on an exact fit, or when empty', () => {
    const row = (n: number) => ({ id: `r${n}`, at: n })
    expect(keysetPage([row(1), row(2)], 5, (r) => ({ sort: r.at, id: r.id })).nextCursor).toBeNull()
    expect(keysetPage([row(1), row(2), row(3), row(4), row(5)], 5, (r) => ({ sort: r.at, id: r.id })).nextCursor).toBeNull()
    expect(keysetPage([], 5, (r: Row) => ({ sort: r.at, id: r.id }))).toEqual({ items: [], nextCursor: null })
  })

  it('does not return the extra row it fetched to look ahead', () => {
    const rows = Array.from({ length: 6 }, (_, n) => ({ id: `r${n}`, at: n }))
    const page = keysetPage(rows, 5, (r) => ({ sort: r.at, id: r.id }))
    expect(page.items).toHaveLength(5)
    expect(decodeKeysetCursor(page.nextCursor!)).toEqual({ sort: 4, id: 'r4' })
  })

  it('does not skip or repeat rows when a new row arrives between pages', () => {
    const rows: Row[] = Array.from({ length: 10 }, (_, n) => ({ id: `r${n}`, at: n }))
    const first = keysetPage(seek(rows, 'desc', null, 4), 3, (r) => ({ sort: r.at, id: r.id }))
    rows.push({ id: 'new', at: 100 })
    const decoded = decodeKeysetCursor(first.nextCursor!)!
    const second = keysetPage(seek(rows, 'desc', { sort: decoded.sort as number, id: decoded.id }, 4), 3, (r) => ({ sort: r.at, id: r.id }))
    expect(first.items.map((r) => r.id)).toEqual(['r9', 'r8', 'r7'])
    expect(second.items.map((r) => r.id)).toEqual(['r6', 'r5', 'r4'])
  })
})

describe('offset cursors', () => {
  it('round-trips and rejects other input', () => {
    expect(decodeOffsetCursor(encodeOffsetCursor(0))).toBe(0)
    expect(decodeOffsetCursor(encodeOffsetCursor(250))).toBe(250)
    expect(decodeOffsetCursor('garbage')).toBeNull()
    expect(decodeOffsetCursor(Buffer.from('{"k":"offset","o":-1}').toString('base64url'))).toBeNull()
    expect(decodeOffsetCursor(Buffer.from('{"k":"offset","o":1.5}').toString('base64url'))).toBeNull()
    expect(decodeOffsetCursor(Buffer.from('{"k":"offset","o":99999999}').toString('base64url'))).toBeNull()
  })
})

describe('offsetPage', () => {
  const all = Array.from({ length: 12 }, (_, n) => n)

  it('pages through a computed list and ends with no cursor', () => {
    const seen: number[] = []
    let offset = 0
    for (let guard = 0; guard < 10; guard++) {
      const page = offsetPage(all, offset, 5)
      seen.push(...page.items)
      if (!page.nextCursor) break
      offset = decodeOffsetCursor(page.nextCursor)!
    }
    expect(seen).toEqual(all)
  })

  it('has no cursor when the list ends exactly on the page', () => {
    expect(offsetPage(all, 7, 5).nextCursor).toBeNull()
    expect(offsetPage(all, 0, 12).nextCursor).toBeNull()
    expect(offsetPage([], 0, 5)).toEqual({ items: [], nextCursor: null })
  })

  it('gives an empty page past the end', () => {
    expect(offsetPage(all, 50, 5)).toEqual({ items: [], nextCursor: null })
  })
})

describe('offsetCursorAfterPage', () => {
  it('points at the next page, and is null on the last', () => {
    expect(decodeOffsetCursor(offsetCursorAfterPage(1, 20, 45)!)).toBe(20)
    expect(decodeOffsetCursor(offsetCursorAfterPage(2, 20, 45)!)).toBe(40)
    expect(offsetCursorAfterPage(3, 20, 45)).toBeNull()
    expect(offsetCursorAfterPage(1, 20, 20)).toBeNull()
    expect(offsetCursorAfterPage(1, 20, 0)).toBeNull()
  })
})

describe('cursorParam', () => {
  it('is optional and bounded', () => {
    expect(cursorParam.safeParse(undefined).success).toBe(true)
    expect(cursorParam.safeParse('abc').success).toBe(true)
    expect(cursorParam.safeParse('').success).toBe(false)
    expect(cursorParam.safeParse('x'.repeat(401)).success).toBe(false)
  })
})

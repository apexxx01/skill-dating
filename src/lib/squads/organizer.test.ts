import { describe, it, expect } from 'vitest'
import { csvCell, csvRow } from './organizer'

describe('csvCell', () => {
  it('leaves plain values as they are and empties nothing-values', () => {
    expect(csvCell('Squad 7')).toBe('Squad 7')
    expect(csvCell(3)).toBe('3')
    expect(csvCell(true)).toBe('true')
    expect(csvCell(null)).toBe('')
    expect(csvCell(undefined)).toBe('')
  })

  it('quotes commas, quotes and line breaks', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('two\nlines')).toBe('"two\nlines"')
  })

  it('never lets a cell be read as a formula', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(csvCell('+1')).toBe("'+1")
    expect(csvCell('-2')).toBe("'-2")
    expect(csvCell('@cmd')).toBe("'@cmd")
  })

  it('joins a row', () => {
    expect(csvRow(['a', null, 'b,c', 1])).toBe('a,,"b,c",1')
  })
})

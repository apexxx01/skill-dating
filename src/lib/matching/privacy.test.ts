import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

// The date of birth is the most private thing the platform holds about a person. "Never returned by any route except the owner's own
// profile read" is a rule about the whole code base, so it is checked against the whole code base: only the files below may so much as
// name the column. A file that needs to is added here on purpose, with the reason.

const SRC = path.resolve(__dirname, '..', '..')
const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(full)
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [full] : []
  })
const rel = (file: string) => path.relative(SRC, file).split(path.sep).join('/')

const MAY_NAME_BIRTH_DATE: Record<string, string> = {
  'lib/matching/dating.ts': 'the age rule: reads it to decide, returns no date',
  'lib/matching/profile.ts': 'loads it for the dating gate; the view it returns carries only the verdict',
  'lib/matching/candidates.ts': 'the SQL for who may be shown for DATING; selects nobody’s date',
  'lib/profile-settings.ts': 'the owner’s own settings schema',
  'app/api/users/me/profile/route.ts': 'the owner’s own profile read and its one-time write',
  'lib/user-sync.ts': 'wipes it when the account is deleted',
  'types/api.ts': 'documents the owner’s own profile settings',
}

describe('the date of birth stays private', () => {
  const files = walk(SRC)

  it('finds the source files to scan', () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it('is named only by the files that need it', () => {
    const naming = files.filter((file) => /birthDate|birth_date|"birthDate"/.test(fs.readFileSync(file, 'utf-8'))).map(rel).sort()
    expect(naming).toEqual(Object.keys(MAY_NAME_BIRTH_DATE).filter((name) => naming.includes(name)).sort())
    for (const name of naming) expect(Object.keys(MAY_NAME_BIRTH_DATE), `${name} may not name the date of birth`).toContain(name)
  })

  it('is never part of a response except the owner’s profile settings', () => {
    // A route that returns it would have to name it (above), so this checks the routes among the allowed files: only the owner's own.
    const routes = files.filter((file) => rel(file).startsWith('app/api/') && /birthDate/.test(fs.readFileSync(file, 'utf-8'))).map(rel)
    expect(routes).toEqual(['app/api/users/me/profile/route.ts'])
  })

  it('is not part of the API types other than the owner’s settings', () => {
    const types = fs.readFileSync(path.join(SRC, 'types', 'api.ts'), 'utf-8')
    const mentions = types.split('\n').filter((line) => /birthDate/.test(line))
    expect(mentions).toHaveLength(1)
  })
})

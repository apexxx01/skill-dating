import { describe, it, expect } from 'vitest'
import { Prisma } from '@prisma/client'
import { DATA_INVENTORY, inventoryFields } from './inventory'

// The deletion and export coverage test. It reads the schema Prisma was generated from, so a new table (or a new column) that points at a person fails
// here until DATA_INVENTORY says what an export gives and what deleting the account does to it.
const models = Prisma.dmmf.datamodel.models
const LOOSE_ID = /(userId|UserId|ById|userIds|UserIds|memberIds|AuthorIds)$/

/** Every (model, field) that holds a user id: the foreign keys to User, and the plain id columns. */
function userReferences(): string[] {
  const refs: string[] = []
  for (const model of models) {
    const relationFks = new Set(model.fields.flatMap((field) => field.relationFromFields ?? []))
    for (const field of model.fields) {
      if (field.kind === 'object' && field.type === 'User' && field.relationFromFields?.length) for (const fk of field.relationFromFields) refs.push(`${model.name}.${fk}`)
      if (field.kind === 'scalar' && field.type === 'String' && !relationFks.has(field.name) && LOOSE_ID.test(field.name)) refs.push(`${model.name}.${field.name}`)
    }
  }
  return [...new Set(refs)].sort()
}

describe('the data inventory', () => {
  it('has a deletion and an export rule for every column that holds a user id', () => {
    const covered = inventoryFields()
    const missing = userReferences().filter((ref) => !covered.has(ref))
    expect(missing, 'add these to src/lib/privacy/inventory.ts with what deleting an account does to them').toEqual([])
  })

  it('names only models and columns that exist', () => {
    for (const ref of inventoryFields().keys()) {
      const [modelName, field] = ref.split('.')
      const model = models.find((m) => m.name === modelName)
      expect(model, `${modelName} is not a model`).toBeDefined()
      expect(model!.fields.map((f) => f.name), `${ref} is not a column`).toContain(field)
    }
  })

  it('redacts only columns that exist, and only from REDACTED entries', () => {
    for (const [name, entry] of Object.entries(DATA_INVENTORY)) {
      const model = models.find((m) => m.name === name.split('_')[0])!
      for (const column of entry.redact ?? []) expect(model.fields.map((f) => f.name), `${name}.${column}`).toContain(column)
      if (entry.redact?.length) expect(entry.export).toBe('REDACTED')
    }
  })

  it('wipes the private things the account had: the date of birth, the romance data, sparks, drops, matches, follows and the rest', () => {
    const covered = inventoryFields()
    for (const ref of ['Spark.fromId', 'Drop.userId', 'Match.userAId', 'RomanceProfile.userId', 'ShipPost.authorId', 'Prop.userId', 'Comment.authorId', 'Follow.followerId', 'CommitmentPledge.userId', 'PeerReview.revieweeId', 'LfgPost.authorId', 'MatchingProfile.userId', 'MediaAsset.ownerId', 'Mute.muterId', 'Block.blockerId']) {
      expect(['DELETE', 'SCRUB', 'CUSTOM'], ref).toContain(covered.get(ref))
    }
    expect(covered.get('ProductEvent.userId')).toBe('SET_NULL')
  })

  it('exports only through columns it knows', () => {
    for (const [name, entry] of Object.entries(DATA_INVENTORY)) for (const field of entry.exportVia ?? []) expect(Object.keys(entry.fields), `${name}.${field}`).toContain(field)
  })

  it('never exports the other side of a one-sided relation: who blocked, muted, sparked or was shown the person', () => {
    expect(DATA_INVENTORY.Block.exportVia).toEqual(['blockerId'])
    expect(DATA_INVENTORY.Mute.exportVia).toEqual(['muterId'])
    expect(DATA_INVENTORY.Spark.exportVia).toEqual(['fromId'])
    expect(DATA_INVENTORY.Drop.exportVia).toEqual(['userId'])
    expect(DATA_INVENTORY.RomanceDrop.exportVia).toEqual(['userId'])
    expect(DATA_INVENTORY.Report.redact).toContain('reporterId')
    expect(DATA_INVENTORY.PeerReview.redact).toContain('reviewerId')
  })

  it('gives a reason for everything it keeps or leaves out of the export', () => {
    for (const [name, entry] of Object.entries(DATA_INVENTORY)) expect(entry.note.trim().length, name).toBeGreaterThan(4)
  })
})

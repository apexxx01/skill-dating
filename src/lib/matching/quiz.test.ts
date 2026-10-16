import { describe, it, expect } from 'vitest'
import { QUIZ_VERSION, quizForClient, readWorkingStyle, WORKING_STYLE_QUIZ, workingStyleSchema, workingStyleSimilarity } from './quiz'

describe('the quiz', () => {
  it('has a short, fixed set of questions with unique ids and at least two ordered options each', () => {
    expect(WORKING_STYLE_QUIZ.length).toBeGreaterThanOrEqual(5)
    expect(WORKING_STYLE_QUIZ.length).toBeLessThanOrEqual(8)
    expect(new Set(WORKING_STYLE_QUIZ.map((q) => q.id)).size).toBe(WORKING_STYLE_QUIZ.length)
    for (const question of WORKING_STYLE_QUIZ) {
      expect(question.options.length).toBeGreaterThanOrEqual(2)
      expect(new Set(question.options.map((o) => o.id)).size).toBe(question.options.length)
      expect(question.prompt.endsWith('?')).toBe(true)
    }
  })

  it('is served as ids, prompts and labelled options with a version', () => {
    const served = quizForClient()
    expect(served.version).toBe(QUIZ_VERSION)
    expect(served.questions).toHaveLength(WORKING_STYLE_QUIZ.length)
    expect(served.questions[0]).toEqual({ id: 'pace', prompt: expect.any(String), options: [{ id: 'steady', label: expect.any(String) }, expect.anything(), expect.anything()] })
  })
})

describe('workingStyleSchema', () => {
  it('accepts any subset of questions with valid options, including none', () => {
    expect(workingStyleSchema.safeParse({}).success).toBe(true)
    expect(workingStyleSchema.safeParse({ pace: 'steady' }).success).toBe(true)
    expect(workingStyleSchema.safeParse(Object.fromEntries(WORKING_STYLE_QUIZ.map((q) => [q.id, q.options[0].id]))).success).toBe(true)
  })

  it('refuses an unknown question or an option that belongs to another question', () => {
    expect(workingStyleSchema.safeParse({ hobby: 'chess' }).success).toBe(false)
    expect(workingStyleSchema.safeParse({ pace: 'night' }).success).toBe(false)
    expect(workingStyleSchema.safeParse({ pace: 5 }).success).toBe(false)
    expect(workingStyleSchema.safeParse(['steady']).success).toBe(false)
  })
})

describe('readWorkingStyle', () => {
  it('keeps the answers that are still valid and drops the rest', () => {
    expect(readWorkingStyle({ pace: 'steady', rhythm: 'night', retired: 'x', risk: 'nonsense', planning: 4 })).toEqual({ pace: 'steady', rhythm: 'night' })
  })
  it('reads anything else as no answers', () => {
    for (const value of [null, undefined, 'pace', 3, [], true]) expect(readWorkingStyle(value)).toEqual({})
  })
})

describe('workingStyleSimilarity', () => {
  it('is 1 for the same answers, 0 for the two ends, and in between for neighbours', () => {
    expect(workingStyleSimilarity({ pace: 'steady' }, { pace: 'steady' })).toBe(1)
    expect(workingStyleSimilarity({ pace: 'steady' }, { pace: 'sprints' })).toBe(0)
    expect(workingStyleSimilarity({ pace: 'steady' }, { pace: 'balanced' })).toBe(0.5)
    expect(workingStyleSimilarity({ rhythm: 'morning' }, { rhythm: 'night' })).toBe(0)
    expect(workingStyleSimilarity({ rhythm: 'evening' }, { rhythm: 'night' })).toBeCloseTo(2 / 3, 9)
  })

  it('averages over the questions both answered, and ignores the rest', () => {
    expect(workingStyleSimilarity({ pace: 'steady', rhythm: 'night', risk: 'bet' }, { pace: 'sprints', rhythm: 'night' })).toBe(0.5)
  })

  it('is symmetric', () => {
    const a = { pace: 'steady', planning: 'light', rhythm: 'morning' }
    const b = { pace: 'sprints', planning: 'light', rhythm: 'evening' }
    expect(workingStyleSimilarity(a, b)).toBe(workingStyleSimilarity(b, a))
  })

  it('is null when there is nothing to compare', () => {
    expect(workingStyleSimilarity({}, {})).toBeNull()
    expect(workingStyleSimilarity({ pace: 'steady' }, { rhythm: 'night' })).toBeNull()
    expect(workingStyleSimilarity({ pace: 'unknown' }, { pace: 'unknown' })).toBeNull()
  })
})

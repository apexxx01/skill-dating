import { z } from 'zod'
import type { WorkingStyleAnswers } from './types'

// The working-style quiz: a short, fixed set of questions about how a person likes to build. It lives in code, not in the
// database, so every answer in storage means the same thing for everybody; GET /api/matching/quiz serves it to the client.
// Every question's options are ORDERED from one end of a spectrum to the other, which is what lets two answers be
// compared (how far apart are "sprints" and "steady"?). Change a question's wording freely; changing the order or ids of options,
// or adding questions, is what bumps QUIZ_VERSION.

export const QUIZ_VERSION = 1

export interface QuizOption {
  id: string
  label: string
}

export interface QuizQuestion {
  id: string
  prompt: string
  /** From one end of the spectrum to the other. */
  options: readonly QuizOption[]
}

export const WORKING_STYLE_QUIZ: readonly QuizQuestion[] = [
  {
    id: 'pace',
    prompt: 'How do you like to pace a build?',
    options: [
      { id: 'steady', label: 'Steady: a little every day' },
      { id: 'balanced', label: 'A mix of steady days and bursts' },
      { id: 'sprints', label: 'Short, intense sprints' },
    ],
  },
  {
    id: 'communication',
    prompt: 'How do you like to talk while building?',
    options: [
      { id: 'async', label: 'Written and async; deep focus in between' },
      { id: 'mixed', label: 'Async day to day, a call when it matters' },
      { id: 'live', label: 'Live and often: calls, pairing, quick chats' },
    ],
  },
  {
    id: 'planning',
    prompt: 'How much do you plan before you build?',
    options: [
      { id: 'structured', label: 'A clear plan and milestones first' },
      { id: 'light', label: 'A light outline, then adjust' },
      { id: 'improvised', label: 'Start building and find the shape as I go' },
    ],
  },
  {
    id: 'decisions',
    prompt: 'How should decisions get made?',
    options: [
      { id: 'consensus', label: 'Together, until we agree' },
      { id: 'owners', label: 'Whoever owns the area decides' },
      { id: 'lead', label: 'One person leads and the rest commit' },
    ],
  },
  {
    id: 'rhythm',
    prompt: 'When are you at your best?',
    options: [
      { id: 'morning', label: 'Early mornings' },
      { id: 'daytime', label: 'Standard working hours' },
      { id: 'evening', label: 'Evenings' },
      { id: 'night', label: 'Late at night' },
    ],
  },
  {
    id: 'risk',
    prompt: 'What do you do with a risky idea?',
    options: [
      { id: 'prove-first', label: 'Prove it small before committing' },
      { id: 'timebox', label: 'Time-box an attempt' },
      { id: 'bet', label: 'Bet on it and move fast' },
    ],
  },
] as const

const BY_ID = new Map(WORKING_STYLE_QUIZ.map((question) => [question.id, question]))

/** The answers a request may carry: any subset of the questions, each with one of its options. Unknown questions or options are refused. */
export const workingStyleSchema = z
  .record(z.string(), z.string())
  .superRefine((answers, ctx) => {
    for (const [questionId, optionId] of Object.entries(answers)) {
      const question = BY_ID.get(questionId)
      if (!question) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [questionId], message: 'Not a question of the quiz' })
      } else if (!question.options.some((option) => option.id === optionId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [questionId], message: `Not an option of "${questionId}"` })
      }
    }
  })

/** What is stored may be older than the quiz: keep only the answers that are still valid. */
export function readWorkingStyle(value: unknown): WorkingStyleAnswers {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const answers: WorkingStyleAnswers = {}
  for (const [questionId, optionId] of Object.entries(value as Record<string, unknown>)) {
    const question = BY_ID.get(questionId)
    if (question && typeof optionId === 'string' && question.options.some((option) => option.id === optionId)) answers[questionId] = optionId
  }
  return answers
}

/**
 * How alike two sets of answers are, 0 to 1, over the questions both answered: 1 for the same option, 0 for the two ends of the
 * spectrum, in between for neighbours. Null when they have no question in common (there is nothing to compare).
 */
export function workingStyleSimilarity(a: WorkingStyleAnswers, b: WorkingStyleAnswers): number | null {
  let total = 0
  let compared = 0
  for (const question of WORKING_STYLE_QUIZ) {
    const left = question.options.findIndex((option) => option.id === a[question.id])
    const right = question.options.findIndex((option) => option.id === b[question.id])
    if (left < 0 || right < 0) continue
    compared += 1
    total += 1 - Math.abs(left - right) / (question.options.length - 1)
  }
  return compared === 0 ? null : total / compared
}

/** The quiz as GET /api/matching/quiz serves it. */
export function quizForClient() {
  return { version: QUIZ_VERSION, questions: WORKING_STYLE_QUIZ.map((question) => ({ id: question.id, prompt: question.prompt, options: question.options.map((option) => ({ id: option.id, label: option.label })) })) }
}

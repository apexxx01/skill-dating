import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatDate(date: Date | string, options?: Intl.DateTimeFormatOptions): string {
  const d = new Date(date)
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    ...options,
  })
}

export function formatRelativeTime(date: Date | string): string {
  const d = new Date(date)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffSecs = Math.floor(diffMs / 1000)
  const diffMins = Math.floor(diffSecs / 60)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)
  const diffWeeks = Math.floor(diffDays / 7)
  const diffMonths = Math.floor(diffDays / 30)
  const diffYears = Math.floor(diffDays / 365)

  if (diffSecs < 60) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  if (diffWeeks < 4) return `${diffWeeks}w ago`
  if (diffMonths < 12) return `${diffMonths}mo ago`
  return `${diffYears}y ago`
}

export function formatNumber(num: number): string {
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`
  return num.toString()
}

export function generateSlug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function truncate(text: string, length: number): string {
  if (text.length <= length) return text
  return text.slice(0, length).trim() + '...'
}

export function getInitials(name: string): string {
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

export function calculateXpForLevel(level: number): number {
  return Math.floor(100 * Math.pow(1.5, level - 1))
}

export function calculateLevelFromXp(xp: number): number {
  let level = 1
  let remainingXp = xp
  while (remainingXp >= calculateXpForLevel(level)) {
    remainingXp -= calculateXpForLevel(level)
    level++
  }
  return level
}

export function calculateXpProgress(xp: number): { level: number; currentLevelXp: number; nextLevelXp: number; progress: number } {
  const level = calculateLevelFromXp(xp)
  let currentLevelXp = 0
  for (let i = 1; i < level; i++) {
    currentLevelXp += calculateXpForLevel(i)
  }
  const nextLevelXp = calculateXpForLevel(level)
  const progress = ((xp - currentLevelXp) / nextLevelXp) * 100
  return { level, currentLevelXp, nextLevelXp, progress: Math.min(100, Math.max(0, progress)) }
}

export function calculateCompatibility(userSkills: { skillId: string; level: number }[], targetSkills: { skillId: string; level: number }[]): number {
  if (userSkills.length === 0 || targetSkills.length === 0) return 0
  
  const userSkillMap = new Map(userSkills.map(s => [s.skillId, s.level]))
  const targetSkillMap = new Map(targetSkills.map(s => [s.skillId, s.level]))
  
  let totalScore = 0
  let maxPossibleScore = 0
  
  // Complementary skills (different categories)
  const allSkillIds = new Set([...userSkillMap.keys(), ...targetSkillMap.keys()])
  
  for (const skillId of allSkillIds) {
    const userLevel = userSkillMap.get(skillId) || 0
    const targetLevel = targetSkillMap.get(skillId) || 0
    
    if (userLevel > 0 && targetLevel > 0) {
      // Overlap - moderate bonus
      totalScore += Math.min(userLevel, targetLevel) * 10
    } else if (userLevel > 0 || targetLevel > 0) {
      // Complementary - higher bonus
      totalScore += Math.max(userLevel, targetLevel) * 15
    }
    maxPossibleScore += 5 * 15 // Max level 5 * complementary bonus
  }
  
  return Math.min(100, Math.round((totalScore / maxPossibleScore) * 100))
}

export function getCompatibilityReason(userSkills: { skillId: string; level: number; category?: string }[], targetSkills: { skillId: string; level: number; category?: string }[]): string {
  const userSkillMap = new Map(userSkills.map(s => [s.skillId, { level: s.level, category: s.category }]))
  const targetSkillMap = new Map(targetSkills.map(s => [s.skillId, { level: s.level, category: s.category }]))
  
  const userCategories = new Set(userSkills.map(s => s.category).filter(Boolean))
  const targetCategories = new Set(targetSkills.map(s => s.category).filter(Boolean))
  
  const overlap = [...userCategories].filter(c => targetCategories.has(c))
  const complementary = [...userCategories].filter(c => !targetCategories.has(c))
  const targetOnly = [...targetCategories].filter(c => !userCategories.has(c))
  
  const reasons: string[] = []
  
  if (complementary.length > 0 && targetOnly.length > 0) {
    reasons.push(`Strong technical complementarity — you specialize in ${complementary.join(', ')} while they specialize in ${targetOnly.join(', ')}.`)
  }
  
  if (overlap.length > 0) {
    reasons.push(`Shared expertise in ${overlap.join(', ')} enables smooth collaboration.`)
  }
  
  if (reasons.length === 0) {
    reasons.push('Complementary skill sets with potential for growth together.')
  }
  
  return reasons.join(' ')
}

export function debounce<T extends (...args: unknown[]) => unknown>(fn: T, ms: number): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout>
  return (...args: Parameters<T>) => {
    clearTimeout(timeoutId)
    timeoutId = setTimeout(() => fn(...args), ms)
  }
}

export function throttle<T extends (...args: unknown[]) => unknown>(fn: T, ms: number): (...args: Parameters<T>) => void {
  let lastCall = 0
  return (...args: Parameters<T>) => {
    const now = Date.now()
    if (now - lastCall >= ms) {
      lastCall = now
      fn(...args)
    }
  }
}

export function isValidUrl(url: string): boolean {
  try {
    new URL(url)
    return true
  } catch {
    return false
  }
}

export function sanitizeHtml(html: string): string {
  return html
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/'/g, '&#039;')
}

export function generateId(): string {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function retry<T>(fn: () => Promise<T>, retries: number = 3, delay: number = 1000): Promise<T> {
  return fn().catch(err => {
    if (retries <= 0) throw err
    return sleep(delay).then(() => retry(fn, retries - 1, delay * 2))
  })
}
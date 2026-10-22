import { createElement, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { SYSTEM_USER_NAME } from '@/lib/matching/system-user'
import type { AchievementCard, CardModel, PassportCard, PostCard, SquadCard } from './models'

// How the share cards look. Brand-neutral on purpose (a dark neutral ground, one accent, Inter): the frontend restyles them when the product has its look, and nothing
// here but the wordmark line says whose they are. Satori draws these (next/og), which supports flexbox and a subset of CSS; every box is `display: flex`.

export const CARD_SIZE = { width: 1200, height: 630 } as const

/** Bump when the drawing changes: it is part of the ETag, so caches fetch the new picture. */
export const LAYOUT_VERSION = 'l1'

const COLORS = {
  ground: '#18181b',
  panel: '#27272a',
  text: '#fafafa',
  muted: '#a1a1aa',
  accent: '#93c5fd',
  line: '#3f3f46',
} as const

const box = (style: CSSProperties, ...children: ReactNode[]): ReactElement => createElement('div', { style: { display: 'flex', ...style } }, ...children)

const text = (style: CSSProperties, value: string): ReactElement => box({ ...style }, value)

function frame(label: string, ...body: ReactNode[]): ReactElement {
  return box(
    { flexDirection: 'column', justifyContent: 'space-between', width: '100%', height: '100%', backgroundColor: COLORS.ground, color: COLORS.text, fontFamily: 'Inter', padding: 64 },
    box({ justifyContent: 'space-between', alignItems: 'center', fontSize: 28, color: COLORS.muted }, text({ fontWeight: 700, color: COLORS.text }, SYSTEM_USER_NAME), text({ letterSpacing: 4 }, label.toUpperCase())),
    box({ flexDirection: 'column', flexGrow: 1, justifyContent: 'center' }, ...body),
  )
}

function stat(value: string, label: string): ReactElement {
  return box({ flexDirection: 'column', marginRight: 56 }, text({ fontSize: 56, fontWeight: 700 }, value), text({ fontSize: 24, color: COLORS.muted }, label))
}

function chip(label: string): ReactElement {
  return box({ fontSize: 26, padding: '8px 20px', marginRight: 14, borderRadius: 999, backgroundColor: COLORS.panel, border: `1px solid ${COLORS.line}` }, label)
}

function passport(card: PassportCard): ReactElement {
  const title = card.name ?? `@${card.username}`
  return frame(
    'Passport',
    text({ fontSize: card.name ? 84 : 72, fontWeight: 700, lineHeight: 1.1 }, title),
    card.name ? text({ fontSize: 34, color: COLORS.accent, marginTop: 8 }, `@${card.username}`) : '',
    card.headline ? text({ fontSize: 38, color: COLORS.muted, marginTop: 20 }, card.headline) : '',
    card.role ? text({ fontSize: 30, color: COLORS.muted, marginTop: 8 }, card.role) : '',
    card.skills.length > 0 ? box({ marginTop: 28 }, ...card.skills.map(chip)) : '',
    box({ marginTop: 44 }, stat(`Level ${card.level}`, card.tier), stat(String(card.projectsShipped), 'projects shipped'), stat(String(card.achievements), 'achievements')),
  )
}

const KIND_LABEL: Record<string, string> = { SHIP: 'Shipped', UPDATE: 'Update', DEVLOG: 'Devlog', DEMO: 'Demo' }

function post(card: PostCard): ReactElement {
  return frame(
    KIND_LABEL[card.postKind] ?? 'Post',
    text({ fontSize: 66, fontWeight: 700, lineHeight: 1.15 }, card.title),
    card.excerpt ? text({ fontSize: 32, color: COLORS.muted, marginTop: 24, lineHeight: 1.35 }, card.excerpt) : '',
    box({ marginTop: 36, alignItems: 'center', fontSize: 30 }, text({ color: COLORS.accent, marginRight: 40 }, card.author), text({ color: COLORS.muted, marginRight: 28 }, `${card.propsCount} Props`), text({ color: COLORS.muted }, `${card.commentCount} comments`)),
  )
}

function squad(card: SquadCard): ReactElement {
  const people = [...card.members, ...(card.unnamed > 0 ? [`+${card.unnamed} more`] : [])]
  return frame(
    'Squad recap',
    text({ fontSize: 30, color: COLORS.accent }, card.hackathon),
    text({ fontSize: 84, fontWeight: 700, lineHeight: 1.1, marginTop: 8 }, card.squad),
    card.project ? text({ fontSize: 36, color: COLORS.muted, marginTop: 16 }, `Built: ${card.project}`) : '',
    people.length > 0 ? box({ marginTop: 28, flexWrap: 'wrap' }, ...people.map(chip)) : '',
    box({ marginTop: 40 }, stat(String(card.memberCount), card.memberCount === 1 ? 'builder' : 'builders'), card.rank ? stat(`#${card.rank}`, 'placed') : ''),
  )
}

function achievement(card: AchievementCard): ReactElement {
  return frame(
    'Achievement',
    text({ fontSize: 84, fontWeight: 700, lineHeight: 1.1 }, card.name),
    card.description ? text({ fontSize: 36, color: COLORS.muted, marginTop: 20, lineHeight: 1.35 }, card.description) : '',
    box({ marginTop: 40 }, card.xp > 0 ? stat(`${card.xp} XP`, 'reward') : '', card.rarityPercent !== null ? stat(`${card.rarityPercent}%`, 'of builders have it') : '', stat(card.earnedOn, 'earned')),
    text({ fontSize: 32, color: COLORS.accent, marginTop: 28 }, card.holder),
  )
}

export function cardElement(card: CardModel): ReactElement {
  switch (card.kind) {
    case 'passport':
      return passport(card)
    case 'post':
      return post(card)
    case 'squad':
      return squad(card)
    case 'achievement':
      return achievement(card)
  }
}

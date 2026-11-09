import { useEffect, useState } from 'react'
import { api, type PartnershipMember } from '@/lib/api'

// Each member has a fixed color used everywhere they appear (schedule dots, name pills), the
// same for every viewer. It's stored per member (partnership_members.color); members without
// one get the first color nobody else is using, in name order.
export const MEMBER_COLORS = {
  blue:   { dot: 'bg-blue-500',    pill: 'border-transparent bg-blue-500 text-white' },
  green:  { dot: 'bg-emerald-500', pill: 'border-transparent bg-emerald-600 text-white' },
  violet: { dot: 'bg-violet-500',  pill: 'border-transparent bg-violet-500 text-white' },
  orange: { dot: 'bg-orange-500',  pill: 'border-transparent bg-orange-500 text-white' },
  cyan:   { dot: 'bg-cyan-500',    pill: 'border-transparent bg-cyan-600 text-white' },
  pink:   { dot: 'bg-pink-500',    pill: 'border-transparent bg-pink-500 text-white' },
}
type ColorName = keyof typeof MEMBER_COLORS
const ORDER = Object.keys(MEMBER_COLORS) as ColorName[]
const OTHER = { dot: 'bg-muted-foreground', pill: 'border-transparent bg-secondary text-secondary-foreground' }
export const DOWNTIME_DOT = 'bg-red-500'
export type MemberColor = typeof OTHER

let cache: Promise<(PartnershipMember & { color?: string | null })[]> | null = null
const loadMembers = () => (cache ||= api.get<(PartnershipMember & { color?: string | null })[]>('/schedule/members').catch(() => { cache = null; return [] }))

function assign(members: (PartnershipMember & { color?: string | null })[]) {
  const map: Record<string, ColorName> = {}
  const used = new Set<ColorName>()
  for (const m of members) if (m.color && m.color in MEMBER_COLORS) { map[m.id] = m.color as ColorName; used.add(m.color as ColorName) }
  for (const m of [...members].sort((a, b) => a.name.localeCompare(b.name))) {
    if (map[m.id]) continue
    const free = ORDER.find(c => !used.has(c)) ?? ORDER[Object.keys(map).length % ORDER.length]
    map[m.id] = free; used.add(free)
  }
  return map
}

// Returns a lookup by user id; unknown ids (non-member pilots, or none) get a neutral color.
export function useMemberColors(): (userId: string | null | undefined) => MemberColor {
  const [map, setMap] = useState<Record<string, ColorName>>({})
  useEffect(() => {
    let live = true
    loadMembers().then(ms => { if (live) setMap(assign(ms)) })
    return () => { live = false }
  }, [])
  return (userId) => (userId && map[userId] ? MEMBER_COLORS[map[userId]] : OTHER)
}

import type { ThreadSummary } from '../types.d'

export function formatTs(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const sameYear = d.getFullYear() === now.getFullYear()
  return d.toLocaleDateString([], sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' })
}

export function participantLine(t: ThreadSummary, selfEmails: string[]): string {
  try {
    const people = JSON.parse(t.participants) as { name: string; email: string }[]
    const others = people.filter((p) => !selfEmails.includes(p.email.toLowerCase()))
    const source = others.length > 0 ? others : people
    const names = source.map((p) => p.name || p.email.split('@')[0])
    const shown = [...new Set(names)].slice(0, 3).join(', ')
    return shown || '(unknown)'
  } catch {
    return '(unknown)'
  }
}

export function counterpartOf(t: ThreadSummary, selfEmails: string[]): { name: string; email: string } | null {
  try {
    const people = JSON.parse(t.participants) as { name: string; email: string }[]
    return people.find((p) => p.email && !selfEmails.includes(p.email.toLowerCase())) ?? people[0] ?? null
  } catch {
    return null
  }
}

export function initials(name: string | null, email: string | null): string {
  const src = name || email || '?'
  const parts = src.trim().split(/\s+/)
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : src.slice(0, 2)).toUpperCase()
}

export function avatarColor(email: string | null): string {
  const palette = ['#e0705a', '#c98a2d', '#5aa564', '#4f96d1', '#8f7ae0', '#d165a8', '#35c3d4']
  let h = 0
  for (const ch of email ?? '?') h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return palette[h % palette.length]
}

export function accountColor(accountId: string, accounts: { id: string }[]): string {
  const idx = accounts.findIndex((a) => a.id === accountId)
  return idx === 0 ? 'var(--accent-personal)' : 'var(--accent-work)'
}

export interface Binding {
  key: string       // KeyboardEvent.key, case-sensitive ('e', 'U', '#', '/')
  meta?: boolean
}

export type ActionId =
  | 'search' | 'compose' | 'reply' | 'done' | 'trash' | 'star' | 'unread' | 'snooze'
  | 'toggleDone' | 'undoDone' | 'peopleSidebar' | 'collapseNav'

export const ACTIONS: { id: ActionId; label: string }[] = [
  { id: 'search', label: 'Focus search' },
  { id: 'compose', label: 'Compose new message' },
  { id: 'reply', label: 'Reply' },
  { id: 'done', label: 'Mark done / not done' },
  { id: 'trash', label: 'Move to trash' },
  { id: 'star', label: 'Star / unstar' },
  { id: 'unread', label: 'Mark read / unread' },
  { id: 'snooze', label: 'Snooze until tomorrow 8am' },
  { id: 'toggleDone', label: 'Show / hide done emails' },
  { id: 'undoDone', label: 'Undo last done' },
  { id: 'peopleSidebar', label: 'Toggle people sidebar' },
  { id: 'collapseNav', label: 'Collapse / expand navigation' }
]

export const DEFAULT_KEYMAP: Record<ActionId, Binding> = {
  search: { key: '/' },
  compose: { key: 'c' },
  reply: { key: 'r' },
  done: { key: 'e' },
  trash: { key: '#' },
  star: { key: 's' },
  unread: { key: 'U' },
  snooze: { key: 'h' },
  toggleDone: { key: 'e', meta: true },
  undoDone: { key: 'z', meta: true },
  peopleSidebar: { key: 'i', meta: true },
  collapseNav: { key: '.', meta: true }
}

const STORAGE_KEY = 'keymap'

export function loadKeymap(): Record<ActionId, Binding> {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    return { ...DEFAULT_KEYMAP, ...saved }
  } catch {
    return { ...DEFAULT_KEYMAP }
  }
}

export function saveKeymap(map: Record<ActionId, Binding>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
}

export function matches(e: KeyboardEvent, b: Binding): boolean {
  return e.key === b.key && !!e.metaKey === !!b.meta
}

export function formatBinding(b: Binding): string {
  const key = b.key === ' ' ? 'Space' : b.key.length === 1 ? b.key.toUpperCase() : b.key
  return `${b.meta ? '⌘' : ''}${key}`
}

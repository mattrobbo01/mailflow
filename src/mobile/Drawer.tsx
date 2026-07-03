import type { Account } from '../types.d'
import type { MobileView } from './InboxScreen'
import { InboxIcon, StarIcon, ClockIcon, SendIcon, LayersIcon, UnifiedIcon, FileIcon, CheckIcon } from '../components/Icons'

const VIEWS: { id: MobileView; label: string; icon: () => React.ReactElement }[] = [
  { id: 'inbox', label: 'Inbox', icon: InboxIcon },
  { id: 'starred', label: 'Starred', icon: StarIcon },
  { id: 'snoozed', label: 'Snoozed', icon: ClockIcon },
  { id: 'sent', label: 'Sent', icon: SendIcon },
  { id: 'drafts', label: 'Drafts', icon: FileIcon },
  { id: 'done', label: 'Done', icon: CheckIcon },
  { id: 'all', label: 'Everything', icon: LayersIcon }
]

export default function Drawer({
  open, view, accountFilter, accounts, onClose, onView, onAccount
}: {
  open: boolean
  view: MobileView
  accountFilter?: string
  accounts: Account[]
  onClose: () => void
  onView: (v: MobileView) => void
  onAccount: (id?: string) => void
}) {
  if (!open) return null

  const item = (active: boolean) =>
    `flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-[15px] ${
      active ? 'bg-white/10 text-zinc-50' : 'text-zinc-300 active:bg-white/5'
    }`

  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-black/50 mf-fade-in" onClick={onClose} />
      <aside className="absolute inset-y-0 left-0 flex w-[290px] flex-col overflow-y-auto bg-[#16181d] px-3 pb-[max(env(safe-area-inset-bottom),16px)] pt-[max(env(safe-area-inset-top),20px)] shadow-2xl mf-slide-right">
        <div className="px-3 pb-4 pt-1">
          <div className="text-[17px] font-bold text-zinc-50">MailFlow</div>
        </div>

        {VIEWS.map((v) => (
          <button key={v.id} onClick={() => onView(v.id)} className={item(view === v.id)}>
            <v.icon />
            {v.label}
          </button>
        ))}

        <div className="mt-5 px-3 pb-1 text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
          Accounts
        </div>
        <button onClick={() => onAccount(undefined)} className={item(accountFilter === undefined)}>
          <UnifiedIcon />
          Unified
        </button>
        {accounts.map((a, i) => (
          <button key={a.id} onClick={() => onAccount(a.id)} className={item(accountFilter === a.id)}>
            <span
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-black/70"
              style={{ background: i === 0 ? 'var(--accent-personal)' : 'var(--accent-work)' }}
            >
              {a.id[0].toUpperCase()}
            </span>
            <span className="min-w-0 truncate">{a.id}</span>
          </button>
        ))}
      </aside>
    </div>
  )
}

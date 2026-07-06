import { useEffect, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import type { Account, DraftRow, Message, ThreadSummary } from '../types.d'

export interface ComposerSeed {
  account: string
  to?: string
  cc?: string
  bcc?: string
  subject?: string
  body?: string
  threadId?: string
  inReplyTo?: string
  references?: string
  quoted?: string
  draftId?: number
  attachments?: { name: string; mimeType: string; dataBase64: string; size: number }[]
}

interface Props {
  accounts: Account[]
  seed: ComposerSeed
  onClose: () => void
  onSent: (undoActionId: number | null, summary: string) => void
  /** Width of the app nav sidebar; full mode starts right of it (Spark keeps the sidebar visible). */
  leftOffset?: number
}

export function replySeed(
  thread: ThreadSummary,
  message: Message,
  selfEmails: string[],
  all = false
): ComposerSeed {
  const from = (message.from_email ?? '').toLowerCase()
  const isSelf = selfEmails.includes(from)
  const toList = (JSON.parse(message.to_json) as { email: string }[]).map((r) => r.email)
  const ccList = (JSON.parse(message.cc_json ?? '[]') as { email: string }[]).map((r) => r.email)

  let to: string[]
  let cc: string[] = []
  if (all) {
    // Reply-all: sender + everyone on To (minus us); keep Cc (minus us).
    const notSelf = (e: string) => !selfEmails.includes(e.toLowerCase())
    to = [...new Set([...(isSelf ? [] : [from]), ...toList.filter(notSelf)])]
    cc = [...new Set(ccList.filter(notSelf))]
    if (to.length === 0) to = toList
  } else {
    to = isSelf ? toList : [from]
  }

  return {
    account: thread.account_id,
    to: to.join(', '),
    cc: cc.join(', '),
    subject: thread.subject?.match(/^re:/i) ? thread.subject : `Re: ${thread.subject}`,
    threadId: thread.id,
    inReplyTo: message.message_id_header ?? undefined,
    references: message.references_header ?? undefined
  }
}

/** Open a saved draft row in the composer (drafts list + in-thread draft cards). */
export function draftSeed(d: DraftRow): ComposerSeed {
  let attachments: ComposerSeed['attachments']
  try { attachments = JSON.parse(d.attachments_json) } catch { attachments = [] }
  return {
    account: d.account, to: d.to_field, cc: d.cc_field, bcc: d.bcc_field,
    subject: d.subject, body: d.body, quoted: d.quoted ?? undefined,
    threadId: d.thread_id ?? undefined, inReplyTo: d.in_reply_to ?? undefined,
    references: d.references_header ?? undefined, draftId: d.id, attachments
  }
}

export function forwardSeed(thread: ThreadSummary, message: Message): ComposerSeed {
  const d = new Date(message.ts * 1000)
  const toNames = (JSON.parse(message.to_json) as { name: string; email: string }[])
    .map((r) => (r.name ? `${r.name} <${r.email}>` : r.email))
    .join(', ')
  const quoted = [
    '---------- Forwarded message ----------',
    `From: ${message.from_name ? `${message.from_name} <${message.from_email}>` : message.from_email}`,
    `Date: ${d.toLocaleString()}`,
    `Subject: ${thread.subject ?? ''}`,
    `To: ${toNames}`,
    '',
    message.body_text ?? message.snippet ?? ''
  ].join('\n')
  return {
    account: thread.account_id,
    subject: thread.subject?.match(/^fwd?:/i) ? thread.subject : `Fwd: ${thread.subject}`,
    threadId: thread.id,
    quoted
  }
}

export const SCHEDULE_PRESETS: { label: string; at: () => Date }[] = [
  { label: 'Tomorrow 8am', at: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); return d } },
  { label: 'Tomorrow 1pm', at: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(13, 0, 0, 0); return d } },
  { label: 'Monday 8am', at: () => { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); d.setHours(8, 0, 0, 0); return d } },
  { label: 'In 2 hours', at: () => new Date(Date.now() + 2 * 3600_000) }
]

/* ---------- inline icons (stroke currentColor, 15px) ---------- */

const icon = { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

function IconExpand() {
  return (
    <svg {...icon}>
      <path d="M14 4h6v6" />
      <path d="M20 4l-7 7" />
      <path d="M10 20H4v-6" />
      <path d="M4 20l7-7" />
    </svg>
  )
}

function IconCompact() {
  return (
    <svg {...icon}>
      <rect x="8" y="4" width="12" height="12" rx="1.5" />
      <path d="M4 8v10a2 2 0 0 0 2 2h10" />
    </svg>
  )
}

function IconClose() {
  return (
    <svg {...icon}>
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </svg>
  )
}

function IconPaperclip() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  )
}

function IconClock() {
  return (
    <svg {...icon}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  )
}

function IconSend() {
  return (
    <svg {...icon}>
      <path d="M21 3L10.5 13.5" />
      <path d="M21 3l-7 18-3.5-7.5L3 10z" />
    </svg>
  )
}

function IconChevrons() {
  return (
    <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 9l5-5 5 5" />
      <path d="M7 15l5 5 5-5" />
    </svg>
  )
}

/* --------------------------------------------------------------- */

const iconBtnCls =
  'flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 hover:bg-white/8 hover:text-zinc-300'

const recipientInputCls =
  'w-full bg-transparent py-1.5 text-[13px] text-zinc-200 outline-none placeholder:text-zinc-600'

/** Comma-separated recipient input with address-book typeahead (↑↓ + Enter/Tab to pick). */
export function RecipientInput({
  value, onChange, placeholder, inputRef
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  inputRef?: React.RefObject<HTMLInputElement | null>
}) {
  const [sugs, setSugs] = useState<{ email: string; name: string | null }[]>([])
  const [sel, setSel] = useState(0)
  const [open, setOpen] = useState(false)
  // Seeded values (replies, AI drafts) must not pop the typeahead — only real typing arms it.
  const typedRef = useRef(false)
  const query = (value.split(',').pop() ?? '').trim()

  useEffect(() => {
    if (!typedRef.current || query.length < 2) {
      setOpen(false)
      return
    }
    let alive = true
    const already = value.toLowerCase()
    window.mailflow
      .contactsSuggest(query)
      .then((r) => {
        if (!alive) return
        const fresh = r.filter((s) => !already.includes(s.email.toLowerCase()) || s.email.toLowerCase() === query.toLowerCase())
        setSugs(fresh)
        setSel(0)
        setOpen(fresh.length > 0)
      })
      .catch(() => {})
    return () => { alive = false }
  }, [query, value])

  function pick(s: { email: string }) {
    const parts = value.split(',')
    parts[parts.length - 1] = ` ${s.email}`
    onChange(parts.join(',').replace(/^ /, '') + ', ')
    setOpen(false)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((i) => Math.min(i + 1, sugs.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((i) => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      e.stopPropagation()
      if (sugs[sel]) pick(sugs[sel])
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      setOpen(false)
    }
  }

  return (
    <div className="relative min-w-0 flex-1">
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => { typedRef.current = true; onChange(e.target.value) }}
        onKeyDown={onKeyDown}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder}
        className={recipientInputCls}
      />
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 min-w-[320px] rounded-lg border border-zinc-700 bg-zinc-800 py-1 shadow-xl">
          {sugs.map((s, i) => (
            <button
              key={s.email}
              onMouseDown={(e) => { e.preventDefault(); pick(s) }}
              onMouseEnter={() => setSel(i)}
              className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left ${i === sel ? 'bg-zinc-700' : ''}`}
            >
              <span className="text-[13px] text-zinc-200">{s.name || s.email}</span>
              {s.name && <span className="truncate text-[12px] text-zinc-500">{s.email}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function Composer({ accounts, seed, onClose, onSent, leftOffset = 0 }: Props) {
  const [mode, setMode] = useState<'full' | 'compact'>(seed.threadId ? 'compact' : 'full')
  const [account, setAccount] = useState(seed.account)
  const [to, setTo] = useState(seed.to ?? '')
  const [cc, setCc] = useState(seed.cc ?? '')
  const [bcc, setBcc] = useState(seed.bcc ?? '')
  const [showCc, setShowCc] = useState(Boolean(seed.cc))
  const [showBcc, setShowBcc] = useState(Boolean(seed.bcc))
  const [subject, setSubject] = useState(seed.subject ?? '')
  const [body, setBody] = useState(seed.body ?? '')
  const [closePrompt, setClosePrompt] = useState(false)
  const [signature, setSignature] = useState<string | null>(null)
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  const [customAt, setCustomAt] = useState('')
  const [attachments, setAttachments] = useState<
    { name: string; mimeType: string; dataBase64: string; size: number }[]
  >(seed.attachments ?? [])

  // Content-bearing composes get a save/discard prompt instead of silently closing.
  const requestClose = () => {
    if (body.trim().length > 0) setClosePrompt(true)
    else onClose()
  }
  async function saveDraft() {
    await window.mailflow.draftSave({
      id: seed.draftId, account, to, cc, bcc, subject, body,
      quoted: seed.quoted, threadId: seed.threadId, inReplyTo: seed.inReplyTo,
      references: seed.references, attachments
    })
    onClose()
  }
  async function discardDraft() {
    if (seed.draftId) await window.mailflow.draftDelete(seed.draftId)
    onClose()
  }
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function addFiles(files: FileList | File[]) {
    for (const f of Array.from(files)) {
      if (f.size > 20 * 1024 * 1024) {
        setError(`${f.name} is over 20 MB — attach it via Drive instead`)
        continue
      }
      const dataUrl: string = await new Promise((res, rej) => {
        const r = new FileReader()
        r.onload = () => res(r.result as string)
        r.onerror = rej
        r.readAsDataURL(f)
      })
      const dataBase64 = dataUrl.split(',')[1] ?? ''
      setAttachments((prev) => [
        ...prev,
        { name: f.name, mimeType: f.type || 'application/octet-stream', dataBase64, size: f.size }
      ])
    }
  }
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const toRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    ;(seed.to ? bodyRef : toRef).current?.focus()
  }, [seed.to])

  useEffect(() => {
    let cancelled = false
    const get = (window as any).mailflow.signatureGet as
      | ((account: string) => Promise<{ html: string } | null>)
      | undefined
    if (!get) {
      setSignature(null)
      return
    }
    get(account)
      .then((r) => { if (!cancelled) setSignature(r?.html ?? null) })
      .catch(() => { if (!cancelled) setSignature(null) })
    return () => { cancelled = true }
  }, [account])

  function mail() {
    return {
      account,
      to: to.split(',').map((s) => s.trim()).filter(Boolean),
      cc: cc.split(',').map((s) => s.trim()).filter(Boolean),
      bcc: bcc.split(',').map((s) => s.trim()).filter(Boolean),
      subject,
      body: seed.quoted ? `${body}\n\n${seed.quoted}` : body,
      threadId: seed.threadId,
      inReplyTo: seed.inReplyTo,
      references: seed.references,
      attachments: attachments.map(({ name, mimeType, dataBase64 }) => ({ name, mimeType, dataBase64 }))
    }
  }

  async function send() {
    if (!to.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const actionId = await window.mailflow.sendNow(mail())
      if (seed.draftId) window.mailflow.draftDelete(seed.draftId)
      onSent(actionId, `Sent “${subject || '(no subject)'}”`)
      onClose()
    } catch (e: any) {
      setError(e.message)
      setBusy(false)
    }
  }

  async function schedule(at: Date) {
    if (!to.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await window.mailflow.sendSchedule(mail(), Math.floor(at.getTime() / 1000))
      if (seed.draftId) window.mailflow.draftDelete(seed.draftId)
      onSent(null, `Scheduled for ${at.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`)
      onClose()
    } catch (e: any) {
      setError(e.message)
      setBusy(false)
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      if (closePrompt) setClosePrompt(false)
      else requestClose()
    }
    if (e.key === 'Enter' && e.metaKey) send()
  }

  const full = mode === 'full'
  const anyExtra = showCc || showBcc

  const recipients = (
    <div>
      {!anyExtra ? (
        <div className="flex items-center">
          <RecipientInput inputRef={toRef} value={to} onChange={setTo} placeholder="To, Cc, Bcc" />
          <button onClick={() => setShowCc(true)} className="px-1.5 text-[12px] text-zinc-500 hover:text-zinc-300">Cc</button>
          <button onClick={() => setShowBcc(true)} className="px-1.5 text-[12px] text-zinc-500 hover:text-zinc-300">Bcc</button>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <span className="w-7 shrink-0 text-[12px] text-zinc-500">To:</span>
            <RecipientInput inputRef={toRef} value={to} onChange={setTo} />
            {!showCc && <button onClick={() => setShowCc(true)} className="px-1.5 text-[12px] text-zinc-500 hover:text-zinc-300">Cc</button>}
            {!showBcc && <button onClick={() => setShowBcc(true)} className="px-1.5 text-[12px] text-zinc-500 hover:text-zinc-300">Bcc</button>}
          </div>
          {showCc && (
            <div className="flex items-center gap-2">
              <span className="w-7 shrink-0 text-[12px] text-zinc-500">Cc:</span>
              <RecipientInput value={cc} onChange={setCc} />
            </div>
          )}
          {showBcc && (
            <div className="flex items-center gap-2">
              <span className="w-7 shrink-0 text-[12px] text-zinc-500">Bcc:</span>
              <RecipientInput value={bcc} onChange={setBcc} />
            </div>
          )}
        </>
      )}
    </div>
  )

  return (
    <div
      onKeyDown={onKeyDown}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files)
      }}
      style={full ? { left: leftOffset } : undefined}
      className={
        full
          ? 'fixed inset-y-0 right-0 z-40 border-l border-white/8 bg-[#1b1e24]'
          : 'fixed bottom-4 right-4 z-40 max-h-[80vh] w-[600px] max-w-[92vw] rounded-xl border border-zinc-700 bg-[#1f2228] shadow-2xl'
      }
    >
      {/* click-outside closes popovers */}
      {(scheduleOpen || accountOpen) && (
        <div
          className="fixed inset-0 z-10"
          onClick={() => { setScheduleOpen(false); setAccountOpen(false) }}
        />
      )}

      {/* window controls: top-left in full mode (Spark-style), top-right in compact */}
      {full ? (
        <>
          {/* When the nav rail is collapsed the macOS traffic lights bleed past it — clear them. */}
          <div style={{ left: leftOffset < 100 ? 36 : 16 }} className="absolute top-4 z-20 flex items-center gap-1">
            <button onClick={requestClose} data-tip="Close" className={iconBtnCls}>
              <IconClose />
            </button>
            <button onClick={() => setMode('compact')} data-tip="Shrink" className={iconBtnCls}>
              <IconCompact />
            </button>
          </div>
          <div className="absolute right-6 top-4 z-20 flex items-center gap-1">
            <ActionCluster
              onAttach={() => fileInputRef.current?.click()}
              popDown
              busy={busy} to={to} account={account} accounts={accounts}
              scheduleOpen={scheduleOpen} setScheduleOpen={setScheduleOpen}
              accountOpen={accountOpen} setAccountOpen={setAccountOpen}
              customAt={customAt} setCustomAt={setCustomAt}
              setAccount={setAccount} send={send} schedule={schedule}
            />
          </div>
        </>
      ) : (
        <div className="absolute right-3 top-3 z-20 flex items-center gap-1">
          <button onClick={() => setMode('full')} data-tip="Expand" className={iconBtnCls}>
            <IconExpand />
          </button>
          <button onClick={requestClose} data-tip="Close" className={iconBtnCls}>
            <IconClose />
          </button>
        </div>
      )}

      <div
        className={
          full
            ? 'h-full w-full overflow-y-auto pb-10 pl-14 pr-12 pt-16'
            : 'flex max-h-[calc(80vh-2px)] min-h-0 flex-col px-6 pb-4 pt-5'
        }
      >
        {/* subject */}
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Subject"
          className={`w-full bg-transparent pb-2 text-[22px] font-semibold text-zinc-100 outline-none placeholder:text-zinc-600 ${full ? '' : 'pr-16'}`}
        />

        {recipients}

        <div className={full ? '' : 'flex min-h-0 flex-1 flex-col overflow-y-auto'}>
          {/* body: top-anchored in full mode (grows with content), stretchy in compact */}
          <textarea
            ref={bodyRef}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Enter text"
            className={`w-full resize-none bg-transparent py-3 text-[13.5px] leading-relaxed text-zinc-200 outline-none placeholder:text-zinc-600 min-h-[48px] [field-sizing:content]`}
          />

          {/* signature preview (the signature carries its own -- delimiter) */}
          {signature && (
            <div className="pb-2">
              <div
                className="text-[13px] text-zinc-300 [&_a]:text-[#35c3d4]"
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(signature) }}
              />
            </div>
          )}

          {seed.quoted && (
            <div className="max-h-20 overflow-hidden border-l-2 border-zinc-700 pl-2 text-[12px] text-zinc-600">
              {seed.quoted.slice(0, 300)}
            </div>
          )}
        </div>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files)
            e.target.value = ''
          }}
        />
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 py-2">
            {attachments.map((a, i) => (
              <span
                key={`${a.name}:${i}`}
                className="flex items-center gap-1.5 rounded-md bg-white/6 px-2 py-1 text-[12px] text-zinc-300"
              >
                <IconPaperclip />
                {a.name}
                <span className="text-zinc-500">{a.size > 1048576 ? `${(a.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(a.size / 1024))} KB`}</span>
                <button
                  onClick={() => setAttachments((p) => p.filter((_, j) => j !== i))}
                  className="text-zinc-500 hover:text-zinc-200"
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}

        {error && <div className="pb-1.5 text-[12px] text-red-400">{error}</div>}

        {/* compact keeps the action bar at the bottom */}
        {!full && (
          <div className="flex items-center border-t border-white/6 pt-2.5">
            <div className="flex-1" />
            <ActionCluster
              onAttach={() => fileInputRef.current?.click()}
              popDown={false}
              busy={busy} to={to} account={account} accounts={accounts}
              scheduleOpen={scheduleOpen} setScheduleOpen={setScheduleOpen}
              accountOpen={accountOpen} setAccountOpen={setAccountOpen}
              customAt={customAt} setCustomAt={setCustomAt}
              setAccount={setAccount} send={send} schedule={schedule}
            />
          </div>
        )}
      </div>

      {closePrompt && (
        <div
          className="absolute inset-0 z-30 flex items-center justify-center rounded-xl bg-black/40"
          onClick={() => setClosePrompt(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-[320px] rounded-xl border border-zinc-700 bg-zinc-900 p-4 shadow-2xl"
          >
            <div className="text-[13.5px] font-medium text-zinc-100">Save this draft?</div>
            <div className="mt-3 flex flex-col gap-1.5">
              <button onClick={saveDraft} className="rounded-md bg-[#1f9dad] py-1.5 text-[13px] font-medium text-white hover:bg-[#35c3d4]">
                Save draft
              </button>
              <button onClick={discardDraft} className="rounded-md border border-zinc-700 py-1.5 text-[13px] text-zinc-300 hover:bg-white/8">
                Delete without saving
              </button>
              <button onClick={() => setClosePrompt(false)} className="py-1 text-[12px] text-zinc-500 hover:text-zinc-300">
                Keep editing
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

interface ActionClusterProps {
  popDown: boolean
  onAttach: () => void
  busy: boolean
  to: string
  account: string
  accounts: Account[]
  scheduleOpen: boolean
  setScheduleOpen: (fn: boolean) => void
  accountOpen: boolean
  setAccountOpen: (fn: boolean) => void
  customAt: string
  setCustomAt: (v: string) => void
  setAccount: (a: string) => void
  send: () => void
  schedule: (at: Date) => void
}

function ActionCluster({
  popDown, onAttach, busy, to, account, accounts, scheduleOpen, setScheduleOpen,
  accountOpen, setAccountOpen, customAt, setCustomAt, setAccount, send, schedule
}: ActionClusterProps) {
  const pop = popDown ? 'top-full right-0 mt-2' : 'bottom-full right-0 mb-2'
  return (
    <>
      <button
        onClick={onAttach}
        data-tip="Attach files"
        className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-300 hover:bg-white/8 hover:text-zinc-100"
      >
        <IconPaperclip />
      </button>
      {/* send later */}
      <div className="relative z-20">
        <button
          onClick={() => { setScheduleOpen(!scheduleOpen); setAccountOpen(false) }}
          disabled={busy || !to.trim()}
          data-tip="Send later"
          className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-300 hover:bg-white/8 hover:text-zinc-100"
        >
          <IconClock />
        </button>
        {scheduleOpen && (
          <div className={`absolute ${pop} w-52 rounded-lg border border-zinc-700 bg-zinc-800 py-1 shadow-xl`}>
            {SCHEDULE_PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => schedule(p.at())}
                className="block w-full px-3 py-1.5 text-left text-[13px] text-zinc-300 hover:bg-zinc-700"
              >
                {p.label}
              </button>
            ))}
            <div className="my-1 border-t border-white/8" />
            <div className="px-3 py-1.5">
              <input
                type="datetime-local"
                value={customAt}
                onChange={(e) => setCustomAt(e.target.value)}
                className="w-full rounded border border-white/10 bg-black/30 px-1.5 py-1 text-[12px] text-zinc-200 outline-none [color-scheme:dark]"
              />
              <button
                onClick={() => customAt && schedule(new Date(customAt))}
                disabled={!customAt || Number.isNaN(Date.parse(customAt)) || Date.parse(customAt) <= Date.now()}
                className="mt-1.5 w-full rounded bg-[#1f9dad] py-1 text-[12px] font-medium text-white hover:bg-[#35c3d4] disabled:opacity-40"
              >
                Schedule
              </button>
            </div>
          </div>
        )}
      </div>

      {/* account picker */}
      <div className="relative z-20">
        <button
          onClick={() => { setAccountOpen(!accountOpen); setScheduleOpen(false) }}
          data-tip="Send from"
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[12.5px] text-zinc-300 hover:bg-white/8 hover:text-zinc-100"
        >
          {account}
          <IconChevrons />
        </button>
        {accountOpen && (
          <div className={`absolute ${pop} min-w-[200px] rounded-lg border border-zinc-700 bg-zinc-800 py-1 shadow-xl`}>
            {accounts.map((a) => (
              <button
                key={a.id}
                onClick={() => { setAccount(a.id); setAccountOpen(false) }}
                className={`block w-full px-3 py-1.5 text-left text-[13px] hover:bg-zinc-700 ${
                  a.id === account ? 'text-[#35c3d4]' : 'text-zinc-300'
                }`}
              >
                {a.id}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* send: always full teal; the click is simply inert until there's a recipient */}
      <button
        onClick={send}
        disabled={busy || !to.trim()}
        data-tip="Send ⌘↩"
        className="ml-1 flex h-8 w-8 items-center justify-center rounded-md text-[#35c3d4] hover:bg-white/8"
      >
        <IconSend />
      </button>
    </>
  )
}

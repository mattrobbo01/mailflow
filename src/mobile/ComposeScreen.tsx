import { useEffect, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import type { Account } from '../types.d'
import { ComposerSeed, RecipientInput, SCHEDULE_PRESETS } from '../components/Composer'
import Sheet from './Sheet'

/**
 * Full-screen mobile compose. Same send/schedule/draft paths as the desktop
 * Composer, laid out for a phone: Cancel / Send in the header, recipient rows,
 * signature preview, attachment chips, send-later via a bottom sheet.
 */
export default function ComposeScreen({
  accounts, seed, onClose, onSent
}: {
  accounts: Account[]
  seed: ComposerSeed
  onClose: () => void
  onSent: (undoActionId: number | null, summary: string) => void
}) {
  const [account, setAccount] = useState(seed.account)
  const [to, setTo] = useState(seed.to ?? '')
  const [cc, setCc] = useState(seed.cc ?? '')
  const [bcc, setBcc] = useState(seed.bcc ?? '')
  const [showCcBcc, setShowCcBcc] = useState(Boolean(seed.cc || seed.bcc))
  const [subject, setSubject] = useState(seed.subject ?? '')
  const [body, setBody] = useState(seed.body ?? '')
  const [signature, setSignature] = useState<string | null>(null)
  const [attachments, setAttachments] = useState<
    { name: string; mimeType: string; dataBase64: string; size: number }[]
  >(seed.attachments ?? [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [closePrompt, setClosePrompt] = useState(false)
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [customAt, setCustomAt] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    ;(seed.to ? bodyRef : undefined)?.current?.focus()
  }, [seed.to])

  useEffect(() => {
    let cancelled = false
    window.mailflow.signatureGet(account)
      .then((r) => { if (!cancelled) setSignature(r?.html ?? null) })
      .catch(() => { if (!cancelled) setSignature(null) })
    return () => { cancelled = true }
  }, [account])

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
      setAttachments((prev) => [
        ...prev,
        { name: f.name, mimeType: f.type || 'application/octet-stream', dataBase64: dataUrl.split(',')[1] ?? '', size: f.size }
      ])
    }
  }

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
      setScheduleOpen(false)
    }
  }

  async function saveDraft() {
    await window.mailflow.draftSave({
      id: seed.draftId, account, to, cc, bcc, subject, body,
      quoted: seed.quoted, threadId: seed.threadId, inReplyTo: seed.inReplyTo,
      references: seed.references, attachments
    })
    onClose()
  }

  const row = 'flex items-center gap-2 border-b border-white/6 px-4 py-1'

  return (
    <div className="mf-screen fixed inset-x-0 top-0 z-40 flex flex-col bg-[#1b1e24] mf-slide-up">
      <header className="flex shrink-0 items-center gap-2 border-b border-white/8 px-3 pb-2 pt-[max(env(safe-area-inset-top),12px)]">
        <button
          onClick={() => (body.trim().length > 0 ? setClosePrompt(true) : onClose())}
          className="px-2 py-1 text-[15px] text-zinc-400"
        >
          Cancel
        </button>
        <div className="min-w-0 flex-1 text-center text-[15px] font-semibold text-zinc-100">
          {seed.threadId ? 'Reply' : 'New Message'}
        </div>
        <button
          onClick={() => fileInputRef.current?.click()}
          aria-label="Attach"
          className="rounded-md p-2 text-zinc-400 active:bg-white/10"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </button>
        <button
          onClick={() => setScheduleOpen(true)}
          disabled={busy || !to.trim()}
          aria-label="Send later"
          className="rounded-md p-2 text-zinc-400 active:bg-white/10 disabled:opacity-40"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <circle cx="12" cy="12" r="8.5" />
            <path d="M12 7.5V12l3 2" />
          </svg>
        </button>
        <button
          onClick={send}
          disabled={busy || !to.trim()}
          className="rounded-full bg-[#1f9dad] px-4 py-1.5 text-[14px] font-semibold text-white disabled:opacity-40"
        >
          {busy ? '…' : 'Send'}
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto pb-8">
        <div className={row}>
          <span className="w-12 shrink-0 text-[13px] text-zinc-500">From</span>
          <select
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            className="min-w-0 flex-1 appearance-none bg-transparent py-1.5 text-[15px] text-zinc-300 outline-none"
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id} className="bg-[#1f2228]">
                {a.id}
              </option>
            ))}
          </select>
        </div>
        <div className={row}>
          <span className="w-12 shrink-0 text-[13px] text-zinc-500">To</span>
          <RecipientInput value={to} onChange={setTo} />
          {!showCcBcc && (
            <button onClick={() => setShowCcBcc(true)} className="px-1.5 text-[13px] text-zinc-500">
              Cc/Bcc
            </button>
          )}
        </div>
        {showCcBcc && (
          <>
            <div className={row}>
              <span className="w-12 shrink-0 text-[13px] text-zinc-500">Cc</span>
              <RecipientInput value={cc} onChange={setCc} />
            </div>
            <div className={row}>
              <span className="w-12 shrink-0 text-[13px] text-zinc-500">Bcc</span>
              <RecipientInput value={bcc} onChange={setBcc} />
            </div>
          </>
        )}
        <div className={row}>
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject"
            className="w-full bg-transparent py-2 text-[16px] font-medium text-zinc-100 outline-none placeholder:text-zinc-600"
          />
        </div>

        <textarea
          ref={bodyRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Enter text"
          className="min-h-[160px] w-full resize-none bg-transparent px-4 py-3 text-[16px] leading-relaxed text-zinc-200 outline-none placeholder:text-zinc-600 [field-sizing:content]"
        />

        {signature && (
          <div className="px-4 pb-2">
            <div
              className="text-[13px] text-zinc-400 [&_a]:text-[#35c3d4]"
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(signature) }}
            />
          </div>
        )}

        {seed.quoted && (
          <div className="mx-4 max-h-24 overflow-hidden border-l-2 border-zinc-700 pl-2 text-[12px] text-zinc-600">
            {seed.quoted.slice(0, 400)}
          </div>
        )}

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
          <div className="flex flex-wrap gap-1.5 px-4 py-2">
            {attachments.map((a, i) => (
              <span key={`${a.name}:${i}`} className="flex items-center gap-1.5 rounded-md bg-white/6 px-2 py-1.5 text-[13px] text-zinc-300">
                {a.name}
                <span className="text-zinc-500">
                  {a.size > 1048576 ? `${(a.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(a.size / 1024))} KB`}
                </span>
                <button onClick={() => setAttachments((p) => p.filter((_, j) => j !== i))} className="px-1 text-zinc-500">
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}

        {error && <div className="px-4 py-2 text-[13px] text-red-400">{error}</div>}
      </div>

      {scheduleOpen && (
        <Sheet title="Send later" onClose={() => setScheduleOpen(false)}>
          <div className="px-4 py-2">
            {SCHEDULE_PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => schedule(p.at())}
                className="block w-full border-b border-white/5 py-3 text-left text-[15px] text-zinc-200 active:bg-white/5"
              >
                {p.label}
              </button>
            ))}
            <div className="flex items-center gap-2 py-3">
              <input
                type="datetime-local"
                value={customAt}
                onChange={(e) => setCustomAt(e.target.value)}
                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-2 py-2 text-[14px] text-zinc-200 outline-none [color-scheme:dark]"
              />
              <button
                onClick={() => customAt && schedule(new Date(customAt))}
                disabled={!customAt || Number.isNaN(Date.parse(customAt)) || Date.parse(customAt) <= Date.now()}
                className="shrink-0 rounded-lg bg-[#1f9dad] px-4 py-2 text-[14px] font-medium text-white disabled:opacity-40"
              >
                Schedule
              </button>
            </div>
          </div>
        </Sheet>
      )}

      {closePrompt && (
        <Sheet title="Save this draft?" onClose={() => setClosePrompt(false)}>
          <div className="flex flex-col gap-2 px-4 py-2">
            <button onClick={saveDraft} className="rounded-xl bg-[#1f9dad] py-3 text-[15px] font-medium text-white">
              Save draft
            </button>
            <button
              onClick={async () => {
                if (seed.draftId) await window.mailflow.draftDelete(seed.draftId)
                onClose()
              }}
              className="rounded-xl border border-zinc-700 py-3 text-[15px] text-zinc-300"
            >
              Delete without saving
            </button>
            <button onClick={() => setClosePrompt(false)} className="py-2 text-[14px] text-zinc-500">
              Keep editing
            </button>
          </div>
        </Sheet>
      )}
    </div>
  )
}

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { HubSpotStatus, PersonContext, ThreadSummary } from '../types.d'
import { formatTs } from '../lib/format'

interface Props {
  email: string | null
  name?: string
  onOpenThread: (accountId: string, threadId: string) => void
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function money(n: number): string {
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
}

/** HubSpot stores IANA zones as e.g. "america_slash_new_york" → "America/New_York". */
function parseHsTimezone(raw: string | null | undefined): string | null {
  if (!raw) return null
  const candidate = raw
    .split('_slash_')
    .map((seg) => seg.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('_'))
    .join('/')
  for (const tz of [candidate, candidate.replace(/_Of_/g, '_of_')]) {
    try {
      new Intl.DateTimeFormat([], { timeZone: tz })
      return tz
    } catch { /* try next */ }
  }
  return null
}

function LocalTime({ hsTimezone }: { hsTimezone: string | null | undefined }) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(t)
  }, [])
  const tz = parseHsTimezone(hsTimezone)
  if (!tz) return null
  const time = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(now)
  const city = tz.split('/').pop()?.replace(/_/g, ' ')
  return (
    <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-zinc-400">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
      {time} <span className="text-zinc-600">· {city}</span>
    </div>
  )
}

function NoteItem({ body, createdAt }: { body: string | null; createdAt: number | null }) {
  const [expanded, setExpanded] = useState(false)
  const text = body ? stripHtml(body) : '(empty note)'
  const isLong = text.length > 180
  return (
    <button onClick={() => isLong && setExpanded((v) => !v)} className="block w-full text-left">
      <div className={`${expanded ? '' : 'line-clamp-3'} text-[12px] leading-snug text-zinc-300`}>
        {text}
      </div>
      <div className="mt-0.5 flex items-center gap-2 text-[11px] text-zinc-600">
        {createdAt != null && <span>{formatTs(createdAt)}</span>}
        {isLong && (
          <span className="text-[#35c3d4]/80">{expanded ? 'Show less' : 'Show more'}</span>
        )}
      </div>
    </button>
  )
}

function stageLabel(stage: string): string {
  // HubSpot stage ids are often like "appointmentscheduled" or "1234567"; prettify the readable ones.
  if (/^\d+$/.test(stage)) return stage
  return stage.replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase())
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-t border-zinc-800/60 px-4 py-3">
      <div className="pb-1.5 text-[10px] font-semibold uppercase tracking-widest text-zinc-600">{title}</div>
      {children}
    </div>
  )
}

function HubSpotConnect({ onConnected }: { onConnected: (s: HubSpotStatus) => void }) {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function connect() {
    if (!token.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const status = await window.mailflow.hubspotSetToken(token)
      if (!status.configured) throw new Error('Token was not accepted')
      onConnected(status)
    } catch (e: any) {
      setError(e.message)
      setBusy(false)
    }
  }

  return (
    <div className="mt-2 rounded-lg border border-white/8 bg-white/4 p-2.5">
      <div className="text-[11.5px] font-medium text-zinc-300">Connect HubSpot</div>
      <div className="mt-1 text-[11px] leading-snug text-zinc-500">
        Create a{' '}
        <a
          href="https://app.hubspot.com/l/private-apps"
          target="_blank"
          rel="noreferrer noopener"
          className="text-[#35c3d4] hover:underline"
        >
          Private App ↗
        </a>{' '}
        with read scopes for contacts, deals and notes, then paste its token:
      </div>
      <input
        value={token}
        onChange={(e) => setToken(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && connect()}
        placeholder="pat-na1-…"
        className="mt-1.5 w-full rounded border border-white/10 bg-black/30 px-2 py-1 text-[11.5px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-[#35c3d4]/50"
      />
      <button
        onClick={connect}
        disabled={busy || !token.trim()}
        className="mt-1.5 w-full rounded bg-[#1f9dad] py-1 text-[11.5px] font-medium text-white hover:bg-[#35c3d4] disabled:opacity-40"
      >
        {busy ? 'Connecting + first sync…' : 'Connect'}
      </button>
      {error && <div className="mt-1 text-[11px] text-red-400">{error}</div>}
    </div>
  )
}

export default function PeopleSidebar({ email, name, onOpenThread }: Props) {
  const [ctx, setCtx] = useState<PersonContext | null>(null)
  const [status, setStatus] = useState<HubSpotStatus | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    window.mailflow.hubspotStatus().then(setStatus).catch(() => {})
  }, [])

  useEffect(() => {
    setCtx(null)
    if (!email) return
    let alive = true
    setLoading(true)
    window.mailflow
      .personForEmail(email)
      .then((c) => { if (alive) setCtx(c) })
      .catch(() => {})
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [email])

  if (!email) {
    return <div className="px-4 py-3 text-[12px] text-zinc-600">No external contact on this thread.</div>
  }
  if (loading && !ctx) {
    return <div className="px-4 py-3 text-[12px] text-zinc-600">Loading…</div>
  }

  let hsProps: Record<string, string | null> = {}
  try {
    if (ctx?.hsContact) hsProps = JSON.parse(ctx.hsContact.properties)
  } catch { /* leave empty */ }

  const displayName = ctx?.person?.name || name || email.split('@')[0]
  const role = ctx?.person?.role || hsProps.jobtitle || null
  const company = ctx?.person?.company || hsProps.company || null
  const hubspotId = ctx?.person?.hubspot_id ?? ctx?.hsContact?.hubspot_id ?? null
  const hubspotUrl = hubspotId
    ? status?.portalId
      ? `https://app.hubspot.com/contacts/${status.portalId}/record/0-1/${hubspotId}`
      : 'https://app.hubspot.com/contacts/'
    : null
  const openDeals = (ctx?.deals ?? []).filter((d) => !(d.stage ?? '').toLowerCase().includes('closed'))
  const linkedinUrl = (() => {
    const raw =
      hsProps.linkedin__twitter_or_website_url || hsProps.linkedin || hsProps.hs_linkedin_url || hsProps.linkedinbio
    if (!raw) return null
    if (/^https?:\/\//i.test(raw)) return raw
    if (/\w+\.\w+/.test(raw)) return `https://${raw.replace(/^\/+/, '')}`
    return null
  })()
  const linkedinLabel = linkedinUrl && /linkedin\.com/i.test(linkedinUrl) ? 'View LinkedIn' : 'View profile'
  const notFound = !ctx?.person && !ctx?.hsContact

  return (
    <div className="flex h-full flex-col overflow-y-auto text-[13px]">
      <div className="px-4 py-3">
        <div className="flex items-center gap-1.5">
          <div className="min-w-0 truncate font-semibold text-zinc-100" title={displayName}>{displayName}</div>
          {hubspotUrl && (
            <a
              href={hubspotUrl}
              target="_blank"
              rel="noreferrer noopener"
              data-tip="Open in HubSpot"
              className="shrink-0 rounded p-0.5 text-[#35c3d4] hover:bg-white/8"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                strokeLinecap="round" strokeLinejoin="round">
                <line x1="7" y1="17" x2="17" y2="7" />
                <polyline points="9 7 17 7 17 15" />
              </svg>
            </a>
          )}
        </div>
        <div className="truncate text-[12px] text-zinc-500" title={email}>{email}</div>
        {(role || company) && (
          <div className="mt-0.5 truncate text-[12px] text-zinc-400">
            {role}{role && company ? ' @ ' : ''}{company}
          </div>
        )}
        <LocalTime hsTimezone={hsProps.hs_timezone} />
        {linkedinUrl && (
          <a
            href={linkedinUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-1 inline-block text-[12px] text-[#35c3d4] hover:text-[#57d1e0]"
          >
            {linkedinLabel}
          </a>
        )}
        {status && !status.configured && <HubSpotConnect onConnected={setStatus} />}
        {notFound && status?.configured && (
          <div className="mt-1.5 text-[11px] text-zinc-600">Not in HubSpot or your notes yet.</div>
        )}
      </div>

      {openDeals.length > 0 && (
        <Section title="Open deals">
          <div className="space-y-1.5">
            {openDeals.map((d) => (
              <div key={d.hubspot_id}>
                <div className="truncate text-zinc-200">{d.name || '(unnamed deal)'}</div>
                <div className="text-[11px] text-zinc-500">
                  {d.stage ? stageLabel(d.stage) : 'No stage'}
                  {d.amount != null ? ` · ${money(d.amount)}` : ''}
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {(ctx?.notes.length ?? 0) > 0 && (
        <Section title="Recent notes">
          <div className="space-y-2.5">
            {ctx!.notes.map((n) => (
              <NoteItem key={n.hubspot_id} body={n.body} createdAt={n.created_at} />
            ))}
          </div>
        </Section>
      )}

      {(ctx?.transcripts.length ?? 0) > 0 && (
        <Section title="Meetings">
          <div className="space-y-1">
            {ctx!.transcripts.map((t) => (
              <div key={t.id} className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate text-zinc-300">{t.title || 'Untitled meeting'}</span>
                {t.started_at != null && (
                  <span className="shrink-0 text-[11px] tabular-nums text-zinc-600">{formatTs(t.started_at)}</span>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      {(ctx?.recentThreads.length ?? 0) > 0 && (
        <Section title="Recent threads">
          <div className="-mx-2">
            {ctx!.recentThreads.map((t: ThreadSummary) => (
              <button
                key={`${t.account_id}:${t.id}`}
                onClick={() => onOpenThread(t.account_id, t.id)}
                className="flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left hover:bg-zinc-900"
              >
                <span className="min-w-0 flex-1 truncate text-zinc-300">{t.subject || '(no subject)'}</span>
                <span className="shrink-0 text-[11px] tabular-nums text-zinc-600">{formatTs(t.last_ts)}</span>
              </button>
            ))}
          </div>
        </Section>
      )}
    </div>
  )
}

import { google } from 'googleapis'
import { getAuthClient, connectedAccountEmails } from '../sync/auth'
import { showMeetingPopup } from '../meeting-popup'
import { isRecording } from '../transcription/sidecar'

export interface LiveMeeting {
  account: string
  eventId: string
  title: string
  start: number
  end: number
  attendees: { email: string; name?: string }[]
  conferenceLink: string
}

/** Events in a window around now that carry a conferencing link. */
export async function liveMeetings(): Promise<LiveMeeting[]> {
  const out: LiveMeeting[] = []
  const now = Date.now()
  for (const account of connectedAccountEmails()) {
    try {
      const cal = google.calendar({ version: 'v3', auth: getAuthClient(account) })
      const res = await cal.events.list({
        calendarId: 'primary',
        timeMin: new Date(now - 10 * 60_000).toISOString(),
        timeMax: new Date(now + 5 * 60_000).toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 10
      })
      for (const ev of res.data.items ?? []) {
        const link =
          ev.hangoutLink ??
          ev.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri ??
          extractMeetingLink(ev.description ?? '') ??
          extractMeetingLink(ev.location ?? '')
        if (!link) continue
        const start = Date.parse(ev.start?.dateTime ?? '') || 0
        const end = Date.parse(ev.end?.dateTime ?? '') || 0
        // Surface ~90s before the start (so the record prompt beats the call).
        if (!start || start > now + 90_000 || end < now) continue
        out.push({
          account,
          eventId: ev.id!,
          title: ev.summary ?? 'Meeting',
          start: Math.floor(start / 1000),
          end: Math.floor(end / 1000),
          attendees: (ev.attendees ?? [])
            .filter((a) => a.email && !a.resource && !a.self)
            .map((a) => ({ email: a.email!, name: a.displayName ?? undefined })),
          conferenceLink: link
        })
      }
    } catch (e: any) {
      console.error(`[calendar:${account}]`, e.message)
    }
  }
  return out
}

function extractMeetingLink(text: string): string | null {
  const m = text.match(/https?:\/\/(?:[\w-]+\.)?(?:zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com)\/[^\s"'<>]+/i)
  return m ? m[0] : null
}

const notified = new Set<string>()

/**
 * Poll every minute; shortly before a meeting with a video link starts, show
 * the Spark-style floating record prompt (always-on-top panel with Start
 * recording / Dismiss — no need to bring MailFlow forward).
 */
export function startMeetingWatcher() {
  setInterval(async () => {
    try {
      if (isRecording()) return // already capturing something — don't prompt over it
      const meetings = await liveMeetings()
      for (const m of meetings) {
        if (notified.has(m.eventId)) continue
        notified.add(m.eventId)
        showMeetingPopup(m)
      }
    } catch {
      /* offline — try again next tick */
    }
  }, 60_000)
}

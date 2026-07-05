import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import type { LiveMeeting } from './calendar/gcal'

/**
 * Spark-style floating record prompt: a small always-on-top panel (top-right,
 * visible over full-screen apps) with real Start recording / Dismiss buttons.
 * Starting kicks the transcription sidecar in the background via the normal
 * IPC channel — the main window never has to come forward.
 */

let popup: BrowserWindow | null = null
let closeTimer: NodeJS.Timeout | null = null

const AUTO_DISMISS_MS = 3 * 60_000 // meeting prompts go stale; don't litter the screen

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function popupHtml(m: LiveMeeting): string {
  const payload = JSON.stringify({
    title: m.title,
    attendees: m.attendees.map((a) => a.email),
    eventId: m.eventId
  }).replace(/</g, '\\u003c')

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; background: transparent; }
    body { font: 13px/1.45 -apple-system, BlinkMacSystemFont, sans-serif; -webkit-user-select: none; }
    /* No box-shadow: it clips at the transparent window's edge and reads as a
       rectangular halo around the card. The border alone defines the shape. */
    .card { margin: 6px; padding: 14px 16px 12px; border-radius: 14px; background: rgba(31,34,40,0.97);
            border: 1px solid rgba(255,255,255,0.14); color: #e4e4e7; -webkit-app-region: drag; }
    .row { display: flex; align-items: center; gap: 8px; }
    .dot { width: 8px; height: 8px; border-radius: 99px; background: #ef4444; flex-shrink: 0;
           animation: pulse 1.6s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: 0.35; } }
    .title { font-weight: 600; font-size: 13.5px; white-space: nowrap; overflow: hidden;
             text-overflow: ellipsis; }
    .sub { color: #8e939b; font-size: 12px; margin: 2px 0 10px 16px; }
    .buttons { display: flex; gap: 8px; justify-content: flex-end; -webkit-app-region: no-drag; }
    button { font: 600 12.5px -apple-system, sans-serif; border: none; border-radius: 8px;
             padding: 6px 12px; cursor: pointer; }
    #rec { background: #dc2626; color: white; }
    #rec:hover { background: #ef4444; }
    #rec:disabled { opacity: 0.6; }
    #dismiss { background: rgba(255,255,255,0.08); color: #a1a1aa; }
    #dismiss:hover { background: rgba(255,255,255,0.14); color: #e4e4e7; }
    #err { color: #f87171; font-size: 11.5px; margin-top: 6px; }
  </style></head><body>
    <div class="card">
      <div class="row"><span class="dot"></span><span class="title">${esc(m.title)}</span></div>
      <div class="sub">Meeting looks live — record &amp; transcribe it?</div>
      <div class="buttons">
        <button id="dismiss">Dismiss</button>
        <button id="rec">Start recording</button>
      </div>
      <div id="err"></div>
    </div>
    <script>
      const M = ${payload}
      const rec = document.getElementById('rec')
      rec.onclick = async () => {
        rec.disabled = true
        rec.textContent = 'Starting…'
        try {
          await window.mailflow.transcriptionStart(M.title, M.attendees, M.eventId)
          window.close()
        } catch (e) {
          document.getElementById('err').textContent = e.message
          rec.disabled = false
          rec.textContent = 'Start recording'
        }
      }
      document.getElementById('dismiss').onclick = () => window.close()
      addEventListener('keydown', (e) => { if (e.key === 'Escape') window.close() })
    </script>
  </body></html>`
}

export function showMeetingPopup(m: LiveMeeting) {
  closeMeetingPopup() // newest meeting wins

  const { workArea } = screen.getPrimaryDisplay()
  const W = 380
  const H = 132
  popup = new BrowserWindow({
    width: W,
    height: H,
    x: workArea.x + workArea.width - W - 12,
    y: workArea.y + 12,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    hasShadow: false, // the card carries its own shadow (transparent window)
    webPreferences: {
      preload: join(__dirname, '../preload/preload.mjs'),
      contextIsolation: true,
      sandbox: false
    }
  })
  popup.setAlwaysOnTop(true, 'screen-saver')
  popup.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  popup.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(popupHtml(m))}`)
  // showInactive: the prompt must never yank focus mid-typing in another app.
  popup.once('ready-to-show', () => popup?.showInactive())
  popup.on('closed', () => {
    popup = null
    if (closeTimer) {
      clearTimeout(closeTimer)
      closeTimer = null
    }
  })
  closeTimer = setTimeout(closeMeetingPopup, AUTO_DISMISS_MS)
}

export function closeMeetingPopup() {
  if (closeTimer) {
    clearTimeout(closeTimer)
    closeTimer = null
  }
  if (popup) {
    try {
      popup.close()
    } catch {
      /* already closed */
    }
    popup = null
  }
}

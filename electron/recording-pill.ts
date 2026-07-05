import { BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'path'
import { onBroadcast } from './broadcast'

// Manual drag channel: CSS drag regions swallow hover, so the pill drags
// itself via pointer events → this move handler. Registered once on import.
ipcMain.on('pill:moveBy', (e, dx: number, dy: number) => {
  if (!pill || e.sender !== pill.webContents) return
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return
  const [x, y] = pill.getPosition()
  pill.setPosition(Math.round(x + dx), Math.round(y + dy))
})

/**
 * LocalFlow-style recording presence: a small always-on-top pill (bottom-right)
 * that shows a pulsing dot + elapsed time while a meeting is being recorded.
 * Hovering swaps it to a Stop button — stopping saves the transcript through
 * the normal sidecar path. Recording itself is fully background: the main
 * window stays on mail, and the live view only exists in the Transcripts tab.
 */

let pill: BrowserWindow | null = null
let offFinished: (() => void) | null = null

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function pillHtml(title: string): string {
  // NO -webkit-app-region: drag anywhere: drag regions swallow mouse events,
  // which kills :hover (and the stop button with it).
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; }
    body { display: flex; align-items: center; justify-content: flex-end; padding-right: 4px;
           box-sizing: border-box; font: 500 12px/1 -apple-system, BlinkMacSystemFont, sans-serif;
           -webkit-user-select: none; }
    .pill { height: 30px; display: flex; align-items: center; gap: 7px; padding: 0 12px;
            border-radius: 999px; background: rgba(31,34,40,0.97); color: #e4e4e7;
            border: 1px solid rgba(255,255,255,0.14); cursor: grab; }
    .pill.dragging { cursor: grabbing; }
    #stop { cursor: pointer; }
    .dot { width: 8px; height: 8px; border-radius: 99px; background: #ef4444; flex-shrink: 0;
           animation: pulse 1.6s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: 0.35; } }
    #time { color: #d4d4d8; font-variant-numeric: tabular-nums; }
    /* Stop control is always in the DOM at zero width; hover grows the pill. */
    #stop { width: 0; opacity: 0; overflow: hidden; margin-left: 0; padding: 0; border: none;
            background: none; color: #f87171; cursor: pointer; display: flex; align-items: center;
            justify-content: center; flex-shrink: 0;
            transition: width 0.15s ease, opacity 0.15s ease, margin-left 0.15s ease; }
    .pill:hover #stop { width: 16px; opacity: 1; margin-left: 3px; }
    #stop:hover { color: #ef4444; }
    #stop:disabled { color: #71717a; }
    .sq { width: 10px; height: 10px; border-radius: 2px; background: currentColor; }
  </style></head><body>
    <div class="pill" title="${esc(title)} — hover to stop">
      <span class="dot"></span><span id="time">0:00</span>
      <button id="stop" title="Stop recording &amp; save transcript"><span class="sq"></span></button>
    </div>
    <script>
      const t0 = Date.now()
      const time = document.getElementById('time')
      setInterval(() => {
        const s = Math.floor((Date.now() - t0) / 1000)
        time.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
      }, 1000)
      const stop = document.getElementById('stop')
      stop.onclick = async () => {
        stop.disabled = true
        document.querySelector('.dot').style.animation = 'none'
        try { await window.mailflow.transcriptionStop() } catch {}
        // transcription:finished also closes us from the main process; this is
        // just the fast path if that event races the window teardown.
        setTimeout(() => window.close(), 4000)
      }

      // Drag: pointer capture keeps move events flowing even when the cursor
      // outruns this tiny window mid-drag.
      const pillEl = document.querySelector('.pill')
      let last = null
      pillEl.addEventListener('pointerdown', (e) => {
        if (e.target.closest('#stop')) return
        pillEl.setPointerCapture(e.pointerId)
        pillEl.classList.add('dragging')
        last = { x: e.screenX, y: e.screenY }
      })
      pillEl.addEventListener('pointermove', (e) => {
        if (!last) return
        const dx = e.screenX - last.x, dy = e.screenY - last.y
        if (dx || dy) {
          window.mailflow.pillMoveBy(dx, dy)
          last = { x: e.screenX, y: e.screenY }
        }
      })
      const endDrag = (e) => {
        last = null
        pillEl.classList.remove('dragging')
        try { pillEl.releasePointerCapture(e.pointerId) } catch {}
      }
      pillEl.addEventListener('pointerup', endDrag)
      pillEl.addEventListener('pointercancel', endDrag)
    </script>
  </body></html>`
}

export function showRecordingPill(title: string) {
  closeRecordingPill()

  const { workArea } = screen.getPrimaryDisplay()
  // Window is sized for the hover-expanded pill; the pill right-aligns inside
  // it, so growing extends leftward and the dot/timer never shift.
  const W = 130
  const H = 38
  pill = new BrowserWindow({
    width: W,
    height: H,
    x: workArea.x + workArea.width - W - 14,
    y: workArea.y + workArea.height - H - 14,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.mjs'),
      contextIsolation: true,
      sandbox: false
    }
  })
  pill.setAlwaysOnTop(true, 'screen-saver')
  pill.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  pill.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(pillHtml(title))}`)
  pill.once('ready-to-show', () => pill?.showInactive())
  pill.on('closed', () => {
    pill = null
  })
  // However the recording ends (pill, Transcripts tab, palette, sidecar error),
  // the finished broadcast retires the pill.
  offFinished = onBroadcast((channel) => {
    if (channel === 'transcription:finished') closeRecordingPill()
  })
}

export function closeRecordingPill() {
  offFinished?.()
  offFinished = null
  if (pill) {
    try {
      pill.close()
    } catch {
      /* already closed */
    }
    pill = null
  }
}

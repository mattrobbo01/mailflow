import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import MobileApp from './mobile/MobileApp'
import { installWebBridge, isPaired, pairingKey } from './lib/bridge-web'
import './styles.css'

// In Safari (iPhone PWA over the LAN bridge) there is no preload — install the
// HTTP implementation of window.mailflow before anything renders.
const inElectron = 'mailflow' in window
if (!inElectron) installWebBridge()

// The Electron window has a 900px min width; anything phone-sized is the PWA.
const isMobile = !inElectron && window.matchMedia('(max-width: 700px)').matches
if (isMobile) {
  document.body.classList.add('mf-lock')
  // iOS gets viewport units wrong in standalone mode (dvh reserves phantom
  // toolbar space → dead strip under bottom bars). innerHeight is ground truth;
  // keep --app-h current across rotations and browser-chrome changes.
  const setAppHeight = () =>
    document.documentElement.style.setProperty('--app-h', `${window.innerHeight}px`)
  setAppHeight()
  window.addEventListener('resize', setAppHeight)
  window.addEventListener('pageshow', setAppHeight)
  window.addEventListener('orientationchange', () => setTimeout(setAppHeight, 300))
  // iOS standalone cold-launch can report a stale innerHeight with no resize
  // event to follow — self-heal over the first moments.
  for (const ms of [150, 500, 1500]) setTimeout(setAppHeight, ms)

  // Report the device's real geometry to the bridge (client-metrics.jsonl in the
  // MailFlow data dir) — iOS viewport bugs can't be diagnosed from screenshots.
  setTimeout(() => {
    const probe = document.createElement('div')
    probe.style.cssText =
      'position:fixed;left:0;width:1px;top:env(safe-area-inset-top);bottom:env(safe-area-inset-bottom);visibility:hidden;pointer-events:none'
    document.body.appendChild(probe)
    const r = probe.getBoundingClientRect()
    const metrics = {
      at: new Date().toISOString(),
      innerH: window.innerHeight,
      innerW: window.innerWidth,
      outerH: window.outerHeight,
      screenH: window.screen.height,
      screenW: window.screen.width,
      dpr: window.devicePixelRatio,
      vvH: window.visualViewport?.height ?? null,
      vvTop: window.visualViewport?.offsetTop ?? null,
      safeTop: r.top,
      safeBottom: window.innerHeight - r.bottom,
      standalone: (navigator as any).standalone ?? null,
      displayMode: window.matchMedia('(display-mode: standalone)').matches ? 'standalone' : 'browser',
      ua: navigator.userAgent
    }
    probe.remove()
    fetch('/client-metrics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-MailFlow-Key': pairingKey() },
      body: JSON.stringify(metrics)
    }).catch(() => {})
  }, 2500)
}

function Pairing() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <div className="text-[17px] font-semibold text-zinc-100">MailFlow</div>
      <div className="text-[14px] leading-relaxed text-zinc-400">
        This device isn't paired. Open the link with the pairing key from your Mac —
        it's printed by the MailFlow app and stored in{' '}
        <span className="text-zinc-300">bridge.json</span>.
      </div>
    </div>
  )
}

const Root = !inElectron && !isPaired() ? Pairing : isMobile ? MobileApp : App

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
)

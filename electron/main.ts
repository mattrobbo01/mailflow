import { app, BrowserWindow, nativeImage, shell } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { registerIpc } from './ipc'
import { startBridge } from './bridge'
import { startSyncLoop } from './sync/orchestrator'
import { startMeetingWatcher } from './calendar/gcal'
import { runHeadless } from './runner'

const isDev = !!process.env.ELECTRON_RENDERER_URL
const isRunner = process.argv.includes('--runner')

function setDockIcon() {
  // Packaged builds get the icon from the bundle; dev runs use raw Electron,
  // so set the dock icon at runtime to tell MailFlow apart from other Electron apps.
  const iconPath = join(app.getAppPath(), 'build', 'icon.png')
  if (process.platform === 'darwin' && existsSync(iconPath)) {
    app.dock?.setIcon(nativeImage.createFromPath(iconPath))
  }
}

function createWindow() {
  const win = new BrowserWindow({
    title: 'MailFlow',
    width: 1440,
    height: 900,
    minWidth: 900,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#1b1e24',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.mjs'),
      contextIsolation: true,
      sandbox: false
    }
  })

  // target="_blank" links (people sidebar, email links) open in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL!)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  if (isRunner) {
    runHeadless()
    return
  }
  setDockIcon()
  registerIpc()
  startBridge() // iPhone PWA access over the LAN
  createWindow()
  startSyncLoop()
  startMeetingWatcher()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // Keep running in the background so sync continues; standard macOS behavior.
})
